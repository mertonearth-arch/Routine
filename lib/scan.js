'use strict';
// Pure logic for the small-float scanner. No network in this file, so all of it
// is unit-tested (lib/scan.test.js); bin/scan.js does the fetching.
//
// What it decides:
//   - WHICH names qualify: float <= 50M shares, or market cap <= $300M.
//   - WHAT KIND of event a headline is (order, FDA approval, offering, reverse
//     split...), by keyword. A type label, not a judgement of the company.
//   - WHICH reported quarter shows a qualifying change (revenue growth,
//     a turn to profit, a narrowing loss), from the published numbers.
//
// What it deliberately does not do: score, rate, rank by quality or recommend.
// "positive-type" means the event is of a kind normally reported as good news
// (an approval, an order, record revenue). It says nothing about whether the
// stock is worth owning, and the dilution list sits right beside it.

const F = require('./format');

const DEFAULTS = {
  maxFloatShares: 50e6,        // the user's line: float under 50M shares...
  maxMarketCap: 300e6,         // ...or market cap under $300M
  // A low share count alone does not make a low-float name: NVR, AutoZone and
  // FICO all have < 50M shares and are $15B+ companies. Above this cap the
  // float route stops qualifying a name.
  floatRouteMaxMarketCap: 2e9,
  minChangePct: 5,             // screener universe: names up at least this much
  minPrice: 0.5,
  minDollarVolume: 250000,     // filters out moves on a few hundred shares
  exchanges: ['NMS', 'NGM', 'NCM', 'NYQ', 'ASE'], // Nasdaq tiers, NYSE, NYSE American — no OTC
  screenPages: 2,
  maxCandidates: 150,          // per run, biggest movers first: fully checked beats half-checked
  maxSecCandidates: 40,        // with SEC on: slots held for 8-K filers (news-bearing items, then smallest cap)
  followUpDays: 10,            // re-check earlier hits this long: good news is often followed by an offering
  lookbackHoursCap: 72,        // Monday AM reaches back over the weekend
  defaultLookbackHours: 24,
  overlapMinutes: 30,          // re-read the edge of the previous window
  minRevenueYoYPct: 25,
  minLossNarrowPct: 25,
  dilutionLookbackDays: 90,
  shareGrowthFlagPct: 30,      // share count up this much over the span shown: flagged as dilution history
  maxStaleDays: 100,           // newest quarter on Yahoo ended longer before the release: it is the previous report
  newsPerTicker: 12,
};

function config(overrides) {
  return Object.assign({}, DEFAULTS, overrides || {});
}

// --- small helpers ---------------------------------------------------------------
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const n = (v) => (isNum(v) ? v : null);
const DAY = 86400000;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
function short(v) {
  if (!isNum(v)) return '?';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return String(Math.round(v));
}
const round = (v, dp) => (isNum(v) ? Number(v.toFixed(dp === undefined ? 2 : dp)) : null);

// The calendar date in New York, which is what a US catalyst is dated by.
const NY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const nyDate = (iso) => (iso ? NY.format(new Date(iso)) : null);

// --- listing filter -------------------------------------------------------------
// Common stock on a listed exchange only. Nasdaq's fifth-letter codes mark
// warrants (W), units (U), rights (R) and other non-common lines (Q, Z);
// Yahoo writes preferreds and NYSE warrants with a dash ("COF-PL", "ABC-WT").
function isCommonListing(symbol, exchange, cfg) {
  cfg = cfg || DEFAULTS;
  if (exchange && cfg.exchanges.indexOf(exchange) === -1) return false;
  const s = String(symbol || '').toUpperCase();
  if (/^[A-Z]{1,4}$/.test(s)) return true;
  if (/^[A-Z]{4}[A-Z]$/.test(s)) return 'QRUWZ'.indexOf(s[4]) === -1;
  if (/^[A-Z]{1,4}-[ABC]$/.test(s)) return true; // share classes, e.g. BRK-B
  return false;
}

// --- qualification ------------------------------------------------------------
// m: { floatShares, sharesOutstanding, marketCap }
function qualify(m, cfg) {
  cfg = cfg || DEFAULTS;
  const fl = n(m.floatShares);
  const so = n(m.sharesOutstanding);
  const mc = n(m.marketCap);
  const by = [];
  let excluded = null;
  const capOk = mc === null || mc <= cfg.floatRouteMaxMarketCap;

  if (fl !== null) {
    if (fl <= cfg.maxFloatShares) {
      if (capOk) by.push('float ' + short(fl) + ' <= ' + short(cfg.maxFloatShares));
      else excluded = 'float ' + short(fl) + ' but market cap $' + short(mc) + ' > $' + short(cfg.floatRouteMaxMarketCap) + ' — a large company with few shares, not a low-float name';
    }
  } else if (so !== null && so <= cfg.maxFloatShares) {
    // Float is a subset of shares outstanding, so this is a guarantee, not an estimate.
    if (capOk) by.push('shares outstanding ' + short(so) + ' <= ' + short(cfg.maxFloatShares) + ' (float can only be lower)');
    else excluded = 'shares outstanding ' + short(so) + ' but market cap $' + short(mc) + ' > $' + short(cfg.floatRouteMaxMarketCap);
  }
  if (mc !== null && mc <= cfg.maxMarketCap) by.push('market cap $' + short(mc) + ' <= $' + short(cfg.maxMarketCap));
  return { ok: by.length > 0, by: by, excluded: excluded };
}

// Cheap first cut on a screener quote, before spending a request on key stats.
// Deliberately loose on shares (150M): float can sit far below shares outstanding
// when insiders hold most of the stock, and only key stats reveal it.
function prefilter(q, cfg) {
  cfg = cfg || DEFAULTS;
  if (!isCommonListing(q.symbol, q.exchange, cfg)) return false;
  const px = n(q.regularMarketPrice);
  if (px !== null && px < cfg.minPrice) return false;
  const vol = n(q.regularMarketVolume);
  if (px !== null && vol !== null && px * vol < cfg.minDollarVolume) return false;
  const mc = n(q.marketCap);
  const so = n(q.sharesOutstanding);
  if (mc !== null && mc <= cfg.maxMarketCap) return true;
  if (so !== null && so <= cfg.maxFloatShares * 3 && (mc === null || mc <= cfg.floatRouteMaxMarketCap)) return true;
  return mc === null && so === null;
}

// --- headline classification ------------------------------------------------------
// Each rule: { type, tone, re, unless }. Tones:
//   dilution  — new shares or the right to issue them (offerings, ATMs, warrant deals, PIPEs)
//   negative  — listing notices, reverse splits, failed trials, going concern, guidance cuts
//   positive  — positive-type events (see header)
//   neutral   — real company news of no inherent direction (an earnings release before the numbers are read)
//   noise     — scheduling, conference appearances, law-firm solicitations
const RULES = [
  { type: 'law-firm notice', tone: 'noise', re: /\b(class action|investor alert|shareholder alert|shareholders? (are )?encouraged to contact|securities (fraud|litigation)|investigation (of|on behalf)|pomerantz|rosen law|levi & korsinsky|bronstein|faruqi|kirby mcinerney|bragar|glancy|schall law|gross law|portnoy law|robbins geller|howard g\. smith|kessler topaz|block & leviton)\b/i },

  { type: 'offering', tone: 'dilution', unless: /\b(terminat(e|es|ed|ing|ion of)|cancel(s|s|led|ling|lation of)?|withdraw(s|n|al of)?|no shares (were )?sold)\b/i, re: /\b(public offering|registered direct|private placement|underwritten offering|best[- ]efforts offering|follow[- ]on offering|offering of (common|ordinary|american depositary)|pricing of|prices? (its |an |a )?(upsized |proposed |\$[\d.,]+\s*(million|m|billion)? )*(public |registered |underwritten |direct )*offering|proposed offering|closes? (its |an |a )?(\$[\d.,]+\s*(million|m|billion)? )?(public |registered direct |underwritten )?offering|PIPE financing)\b/i },
  { type: 'equity line / ATM', tone: 'dilution', unless: /\b(terminat(e|es|ed|ing|ion of)|cancel(s|s|led|ling|lation of)?|withdraw(s|n|al of)?|no shares (were )?sold)\b/i, re: /\b(at[- ]the[- ]market (offering|program|facility|equity|sales)|\bATM (program|offering|facility)\b|equity line|\bELOC\b|standby equity|equity purchase agreement|securities purchase agreement|committed equity facility)\b/i },
  { type: 'warrants / convertibles', tone: 'dilution', unless: /\b(terminat(e|es|ed|ing|ion of)|cancel(s|s|led|ling|lation of)?|withdraw(s|n|al of)?|no shares (were )?sold)\b/i, re: /\b(warrant inducement|inducement (of|letter)|exercise of (outstanding |existing )?warrants|warrant exercise|convertible (senior )?(notes?|debentures?|preferred)|shelf registration|files? (a |an )?(s-1|s-3|f-1|f-3)\b)/i },

  // Ending an ATM / offering / shelf removes a source of new shares.
  { type: 'dilution withdrawn', tone: 'positive', re: /\b(terminat(e|es|ed|ing|ion of)|cancel(s|led|ling|lation of)?|withdraw(s|n|al of)?)\b.{0,50}\b(at[- ]the[- ]market|ATM|offering|equity line|shelf|registration statement|equity purchase agreement)\b/i },
  { type: 'reverse split', tone: 'negative', re: /\breverse (stock |share )?split\b/i },
  { type: 'listing notice', tone: 'negative', unless: /\bregain(s|ed)?\b/i, re: /\b(deficiency|non-?compliance|delist|minimum bid price|notice from (the )?(nasdaq|nyse)|nasdaq (hearings? )?panel|(stockholders|shareholders)'? equity requirement|suspension of trading)\b/i },
  { type: 'going concern / bankruptcy', tone: 'negative', re: /\b(going concern|chapter (7|11|15)|bankruptcy|insolven|receivership|plan of (complete )?liquidation|wind(s|ing)?[- ]down (its |the )?(business|operations|company))\b/i },
  { type: 'clinical / regulatory setback', tone: 'negative', re: /\b(complete response letter|\bCRL\b|clinical hold|did not (meet|achieve)|failed to (meet|achieve)|miss(ed|es)? (its |the )?primary endpoint|discontinu(e|es|ed|ing) (the |its )?(development|trial|study|program)|refusal to file|not approvable|fda (rejects|rejected|declines|denies|denied)|rejects? (\w+ ){0,3}approval|refuses? to approve)\b/i },
  { type: 'guidance cut', tone: 'negative', re: /\b(lowers|cuts|reduces|withdraws|suspends) (its )?((full[- ]year|fy\s?\d{0,4}|annual|fiscal|year|\d{4})\s)*(revenue |sales |earnings |ebitda )?(guidance|outlook|forecast)\b/i },
  { type: 'restatement / auditor', tone: 'negative', re: /\b(restate(s|d|ment)?|non-?reliance|auditor (resign|dismiss)|material weakness)\b/i },
  { type: 'insider selling', tone: 'negative', re: /\b(insiders? (sold|sells|selling|unloads?)|(ceo|cfo|director|chairman|founder) (sold|sells|unloads?) (\w+ ){0,3}(shares|stock))\b/i },
  { type: 'analyst action', tone: 'negative', tag: 'third-party opinion', re: /\b(downgrades?|downgraded|(cuts?|lowers?|slashes) (\w+ ){0,3}(price )?target|target cuts?)\b/i },
  { type: 'executive exit', tone: 'negative', re: /\b(ceo|cfo|chief executive|chief financial)[^.]{0,30}\b(resign|steps? down|terminated|departs?|exit)/i },

  // Earnings with a direction in the headline itself.
  { type: 'earnings', tone: 'negative', tag: 'weak print', re: /\b((revenue|sales) (fell|falls|declined|declines|decreased|decreases|down|dropped|slipped)|(miss(es|ed)?|lag(s|ged)?|below|trail(s|ed)?) (\w+ )?(estimates|expectations|consensus)|wider (net |quarterly )?loss|loss widen(s|ed))\b/i },
  { type: 'earnings', tone: 'positive', tag: 'strong print', re: /\b(record (\w+ )?(revenue|quarter|sales|results|bookings|backlog|orders)|(revenue|sales|bookings) (grew|grows|increased|increases|rose|rises|up|jumped|surged|soared|doubled|tripled)|(grew|increased|doubled) (its )?(revenue|sales)|returns? to profitab|first (ever |quarterly |full[- ]year )?(profit|profitable|net income)|positive (net income|ebitda|operating income|free cash flow|cash flow)|(beats?|tops?|exceed(s|ed)?|surpass(es|ed)?) (\w+ )?(estimates|expectations|consensus|guidance)|narrow(s|ed|er) (net |quarterly )?loss|loss (narrow(s|ed|er)|shrank|shrinks|improved)|raises? (its )?((full[- ]year|fy\s?\d{0,4}|annual|fiscal|year|\d{4})\s)*(revenue |sales |earnings |ebitda )?(guidance|outlook|forecast))\b/i },

  { type: 'M&A (target)', tone: 'positive', re: /\b(to be acquired|agrees? to be acquired|(definitive )?(merger )?agreement to be acquired|acquired by|take[- ]private|go(ing)?[- ]private (transaction|deal)|tender offer (for|to acquire) (all|the outstanding))\b/i },
  { type: 'regulatory / clinical', tone: 'positive', unless: /\b(shareholder|stockholder|transfer (its |of )?listing|board approv)/i, re: /\b(fda (approv|clear|grant|accept)|(receives?|granted|wins?) (\w+ ){0,3}(approval|clearance|designation)|510\(k\)|de novo|breakthrough (therapy|device) designation|fast track|orphan drug|rare pediatric|priority review|positive (topline|top-line|interim|final|phase|pivotal|clinical)?\s?(data|results|readout)|met (its |the |all )?(primary|co-primary) endpoints?|statistically significant|ce mark|ind (clearance|approval)|emergency use authori[sz]ation|fda agreement|agreement with (the )?fda|alignment with (the )?fda|accelerated approval (pathway|path)|(successful|positive) end[- ]of[- ]phase)\b/i },
  { type: 'order / contract', tone: 'positive', unless: /\b(merger|business combination|to acquire|acquisition of|reverse merger|to present|conference|best (places|workplaces)|named (to|as|one)|recogni[sz]ed)\b/i, re: /\b(award(ed|s)? (a |an |the )?(\$?[\d.,]+\s*(million|m|billion|bn|k)?\s*)?([\w-]+ ){0,4}(contract|order|grant|task order|agreement|program)|contract (award|win)|wins? (\w+ ){0,4}(contract|order|award|tender|deal)|(purchase|production|follow[- ]on) orders?|secures? (\w+ ){0,5}(contract|order|deal|award|agreement|customer)|receives? (\w+ ){0,5}(order|contract|award)|selected (by|as)|supply (agreement|contract)|distribution agreement|licens(e|ing) agreement|master (services|supply) agreement|offtake agreement|definitive agreement with|signs? (\w+ ){0,4}(agreement|contract|deal))\b/i },
  { type: 'renewal / extension', tone: 'positive', re: /\b(extend(s|ed|ing)?|extension of|renew(s|ed|ing|al of)?|expand(s|ed|ing)?)\b.{0,50}\b(partnership|agreement|contract|licen[cs]e|collaboration|relationship)\b/i },
  { type: 'partnership', tone: 'positive', tag: 'often non-binding', unless: /\b(merger|business combination)\b/i, re: /\b(announces?|enters? into|forms?|launch(es)?|signs?)\b.{0,80}\b(partnerships?|alliances?|collaborations?|cooperation (agreement|framework)?)\b/i },
  { type: 'partnership', tone: 'positive', tag: 'often non-binding', re: /\b(partner(s|ship|ing)? with|strategic (partnership|alliance|collaboration|investment)|collaborat(ion|es|e|ing) with|joint venture|teams? up|memorandum of understanding|\bMOU\b|letter of intent|\bLOI\b|term sheet)\b/i },
  { type: 'buyback / dividend', tone: 'positive', re: /\b(share repurchase|stock repurchase|buyback|repurchase (program|plan|authori[sz]ation)|special (cash )?dividend|initiates? (a |its first )?(quarterly |annual )?dividend|increases? (its )?(quarterly )?dividend)\b/i },
  { type: 'listing / index', tone: 'positive', re: /\b(regain(s|ed)? compliance|uplist|approved (for listing|to list) on|begins trading on (the )?(nasdaq|nyse)|(added to|join(s|ing)?|inclusion in) (the )?(russell|s&p|msci|nasdaq[- ]100))\b/i },
  { type: 'patent', tone: 'positive', re: /\b(patent (granted|issued|allowance)|(issued|grants?|granted|receives?) (a |an |\w+ )?(u\.s\. |us |european |japanese |chinese )?patent|notice of allowance)\b/i },
  { type: 'insider buying', tone: 'positive', re: /\b(insider (purchase|buying)|(ceo|cfo|director|chairman|insiders?) (buys|bought|purchases|purchased|acquires|acquired) (\w+ ){0,3}(shares|stock)|open[- ]market purchase)\b/i },
  { type: 'launch / milestone', tone: 'positive', tag: 'weak signal', re: /\b(commercial (launch|availability|shipments?)|first (patient (dosed|enrolled)|commercial|shipment|delivery|deliveries|revenue)|launch(es|ed)?\b|achieves? (\w+ ){0,3}milestone|completes? enrollment|successfully (completes?|completed))/i },

  { type: 'analyst action', tone: 'positive', tag: 'third-party opinion', re: /\b(upgrades?|upgraded|raises? (\w+ ){0,3}price target|initiates? coverage (\w+ ){0,5}(buy|outperform|overweight))\b/i },
  { type: 'M&A (acquirer)', tone: 'neutral', re: /\b(to acquire|acquires|acquisition of|completes? (the )?acquisition|merger agreement|business combination|reverse merger)\b/i },
  { type: 'call logistics', tone: 'noise', re: /\b(will|to) (host|hold) .{0,40}(conference call|webcast|call) (on|at|today|tomorrow)\b/i },
  { type: 'scheduling / IR', tone: 'noise', re: /\b(to (report|announce|release) .{0,60}(results|earnings)|to (present|participate|ring|speak|exhibit) (at|in|the)|fireside chat|investor (conference|day|summit)|announces? (the )?(date|timing) (of|for)|schedules? .{0,40}(call|webcast|release)|webinar|annual (general |shareholder )?meeting)\b/i },
  { type: 'earnings', tone: 'neutral', re: /\b(reports?|announces?|posts?|delivers?|releases?)\b.{0,60}\b(results|earnings)\b|\b(first|second|third|fourth|q[1-4])[- ]quarter (\d{4} |fiscal )?(results|earnings|revenue)\b/i },
];

const TONE_ORDER = ['dilution', 'negative', 'positive', 'neutral', 'noise'];

function classify(text) {
  const t = String(text || '');
  const hits = RULES.filter((r) => r.re.test(t) && !(r.unless && r.unless.test(t)));
  if (!hits.length) return { type: 'other', tone: 'neutral', tags: [] };
  const tags = hits.map((h) => h.tag ? h.type + ' (' + h.tag + ')' : h.type)
    .filter((v, i, a) => a.indexOf(v) === i);
  // Law-firm solicitations mention fraud and lawsuits; they are not company news.
  if (hits[0].type === 'law-firm notice') return { type: 'law-firm notice', tone: 'noise', tags: tags };
  const has = (tone) => hits.filter((h) => h.tone === tone);
  const dil = has('dilution');
  if (dil.length) return { type: dil[0].type, tone: 'dilution', tags: tags };
  const neg = has('negative');
  const pos = has('positive');
  const weakPrint = neg.filter((h) => h.type === 'earnings');
  const otherNeg = neg.filter((h) => h.type !== 'earnings');
  if (otherNeg.length) return { type: otherNeg[0].type, tone: 'negative', tags: tags };
  if (pos.length && weakPrint.length) return { type: 'earnings', tone: 'mixed', tags: tags };
  if (pos.length) return { type: pos[0].type, tone: 'positive', tags: tags };
  if (weakPrint.length) return { type: 'earnings', tone: 'negative', tags: tags };
  const neu = has('neutral');
  const noise = has('noise');
  // "to report Q3 results on Nov 13" is scheduling, even though it says "results";
  // "reports Q3 results and will host a call on…" is an earnings release.
  const strongNoise = noise.filter((h) => h.type !== 'call logistics');
  if (strongNoise.length && neu.every((h) => h.type === 'earnings')) return { type: strongNoise[0].type, tone: 'noise', tags: tags };
  if (neu.length) return { type: neu[0].type, tone: 'neutral', tags: tags };
  return { type: noise[0].type, tone: 'noise', tags: tags };
}

// --- who said it ------------------------------------------------------------------
const WIRES = /\b(globe ?newswire|pr ?newswire|business ?wire|access ?newswire|accesswire|newsfile|cision|eqs|issuer direct|notified|marketwired)\b/i;
const COMMENTARY = /\b(motley fool|gurufocus|simply wall|seeking alpha|insider monkey|tipranks|marketbeat|moby|stocktitan|investorplace|24\/7 wall|validea|finbold|benzinga insights|stockstory|stocknews|kiplinger|barchart insights)\b/i;
function sourceClass(publisher) {
  const p = String(publisher || '');
  if (WIRES.test(p)) return 'company release';
  if (COMMENTARY.test(p)) return 'commentary';
  return 'media';
}

// --- SEC filings --------------------------------------------------------------------
const ITEMS = {
  '1.01': ['material agreement', 'neutral'], '1.02': ['agreement terminated', 'negative'],
  '1.03': ['bankruptcy / receivership', 'negative'], '2.01': ['acquisition or disposition completed', 'neutral'],
  '2.02': ['results of operations', 'neutral'], '2.03': ['new debt obligation', 'neutral'],
  '2.05': ['exit / restructuring costs', 'negative'], '2.06': ['material impairment', 'negative'],
  '3.01': ['listing deficiency / delisting notice', 'negative'], '3.02': ['unregistered sale of equity', 'dilution'],
  '3.03': ['change to shareholder rights', 'negative'], '4.01': ['auditor change', 'negative'],
  '4.02': ['non-reliance on prior financials', 'negative'], '5.01': ['change in control', 'neutral'],
  '5.02': ['officer / director change', 'neutral'], '5.03': ['charter or bylaw amendment', 'neutral'],
  '5.07': ['shareholder vote results', 'neutral'], '7.01': ['Reg FD disclosure', 'neutral'],
  '8.01': ['other events', 'neutral'],
};
const DILUTION_FORMS = /^(S-1|S-3|F-1|F-3|S-3ASR|424B[1-8]|FWP)(\/A)?$/;

function describe8K(items) {
  const list = (items || []).filter((i) => i !== '9.01');
  const labels = list.map((i) => i + ' ' + (ITEMS[i] ? ITEMS[i][0] : 'item'));
  let tone = 'neutral';
  list.forEach((i) => {
    const t = ITEMS[i] ? ITEMS[i][1] : 'neutral';
    if (TONE_ORDER.indexOf(t) < TONE_ORDER.indexOf(tone)) tone = t;
  });
  // 1.01 + 3.02 together is the usual shape of a private placement.
  if (list.indexOf('1.01') !== -1 && list.indexOf('3.02') !== -1) tone = 'dilution';
  return { label: labels.join('; ') || 'exhibits only', tone: tone, earnings: list.indexOf('2.02') !== -1 };
}

// --- which names a run checks ------------------------------------------------------
// Governance-only 8-Ks (vote results, officer changes, exhibits) rarely carry
// news, so 8-K filers with any other item go first, then the smallest market cap.
// 5.03 is not on this list: reverse splits are filed under it.
const ROUTINE_8K = ['5.02', '5.07', '9.01'];
const routine8K = (items) => !!(items && items.length) && items.every((i) => ROUTINE_8K.indexOf(i) !== -1);
function rankFilers(list) {
  const cap = (x) => (x.quote && isNum(x.quote.marketCap) ? x.quote.marketCap : Infinity);
  return (list || []).slice()
    .sort((a, b) => (routine8K(a.items) - routine8K(b.items)) || (cap(a) - cap(b)) || a.ticker.localeCompare(b.ticker))
    .map((x) => x.ticker);
}

// Up to maxCandidates names, in order: earlier hits (always), the price movers
// in screen order, then 8-K filers in rank order. Up to maxSecCandidates slots
// are held for filers, so a busy filing day cannot push the movers out and a
// busy tape cannot push the filings out. A filer whose move already ranks among
// the movers is checked as a mover; slots one side leaves unused go to the other.
function pickCandidates(earlier, movers, filers, cfg) {
  cfg = cfg || DEFAULTS;
  const seen = new Set();
  const take = (list, room) => {
    const out = [];
    for (let i = 0; i < (list || []).length && out.length < room; i++) {
      if (seen.has(list[i])) continue;
      seen.add(list[i]);
      out.push(list[i]);
    }
    return out;
  };
  const max = cfg.maxCandidates;
  const e = take(earlier, Infinity);
  const held = Math.min(cfg.maxSecCandidates || 0, (filers || []).filter((t) => !seen.has(t)).length);
  const m = take(movers, Math.max(0, max - e.length - held));
  const f = take(filers, Math.max(0, max - e.length - m.length));
  const more = take(movers, Math.max(0, max - e.length - m.length - f.length));
  return { earlier: e, movers: m.concat(more), filers: f };
}

// Filings over the dilution lookback that bear on share count. Facts only.
function dilutionCheck(filings, today, cfg) {
  cfg = cfg || DEFAULTS;
  const recent = (filings || []).filter((f) => f.filingDate && daysBetween(f.filingDate, today) <= cfg.dilutionLookbackDays);
  const out = [];
  recent.forEach((f) => {
    if (DILUTION_FORMS.test(f.form)) out.push({ form: f.form, date: f.filingDate, url: f.url, why: f.form.indexOf('424B') === 0 ? 'prospectus (offering terms)' : 'registration / shelf' });
    else if (/^8-K/.test(f.form)) {
      if (f.items.indexOf('3.02') !== -1) out.push({ form: f.form, date: f.filingDate, url: f.url, why: 'item 3.02 unregistered equity sale' });
      if (f.items.indexOf('3.01') !== -1) out.push({ form: f.form, date: f.filingDate, url: f.url, why: 'item 3.01 listing deficiency notice' });
      if (f.items.indexOf('3.03') !== -1 || f.items.indexOf('5.03') !== -1) out.push({ form: f.form, date: f.filingDate, url: f.url, why: 'item ' + (f.items.indexOf('3.03') !== -1 ? '3.03' : '5.03') + ' (reverse splits are filed under this; check)' });
    }
  });
  return { flagged: out.length > 0, days: cfg.dilutionLookbackDays, filings: out.slice(0, 8) };
}

// --- dilution history from Yahoo ------------------------------------------------------
// The share count over the last ~18 months (Yahoo's quarterly series, which is
// split-adjusted) and reverse splits over two years (chart history). Works
// without SEC. Flagged when the count grew shareGrowthFlagPct or more over the
// span shown, or the stock reverse-split: the usual marks of a serial diluter.
function shareHistory(series, splits, today, cfg) {
  cfg = cfg || DEFAULTS;
  const pts = (series || []).filter((v) => v && v.asOfDate && isNum(v.value) && v.value > 0 && daysBetween(v.asOfDate, today) <= 550)
    .sort((a, b) => a.asOfDate.localeCompare(b.asOfDate)).slice(-6);
  const reverse = (splits || []).filter((s) => s && s.date && isNum(s.numerator) && isNum(s.denominator) &&
    s.numerator > 0 && s.numerator < s.denominator && daysBetween(s.date, today) <= 730)
    .map((s) => ({ date: s.date, ratio: s.numerator + ':' + s.denominator }));
  if (pts.length < 2 && !reverse.length) return null;
  const growth = pts.length >= 2 ? round(pts[pts.length - 1].value / pts[0].value, 2) : null;
  return {
    points: pts.map((p) => ({ date: p.asOfDate, shares: p.value })), growth: growth, reverseSplits: reverse,
    flagged: (isNum(growth) && growth >= 1 + cfg.shareGrowthFlagPct / 100) || reverse.length > 0,
    source: 'Yahoo Finance fundamentals (split-adjusted) and price history',
  };
}

// --- financials ------------------------------------------------------------------------
// fin: { TotalRevenue:[{asOfDate,value}], NetIncome, DilutedEPS, OrdinarySharesNumber, CashAndCashEquivalents }
function financialDeltas(fin, eventDate, cfg) {
  cfg = cfg || DEFAULTS;
  if (!fin) return null;
  const last = (a) => (a && a.length ? a[a.length - 1] : null);
  const yearAgo = (a, d) => (a || []).filter((v) => Math.abs(daysBetween(v.asOfDate, d) - 365) <= 25).pop() || null;
  const rev = fin.TotalRevenue || [];
  const ni = fin.NetIncome || [];
  const anchor = last(rev) || last(ni);
  if (!anchor) return null;
  const period = anchor.asOfDate;
  const at = (a) => (a || []).filter((v) => v.asOfDate === period).pop() || null;

  const r0 = at(rev);
  const r1 = yearAgo(rev, period);
  const i0 = at(ni);
  const i1 = yearAgo(ni, period);
  const s0 = last(fin.OrdinarySharesNumber);
  const s1 = s0 ? yearAgo(fin.OrdinarySharesNumber, s0.asOfDate) : null;
  const c0 = last(fin.CashAndCashEquivalents);

  const revenueYoY = r0 && r1 && r1.value > 0 ? round((r0.value / r1.value - 1) * 100, 1) : null;
  const turnedProfitable = i0 && i1 ? i0.value > 0 && i1.value <= 0 : false;
  const lossNarrowedPct = i0 && i1 && i0.value < 0 && i1.value < 0 ? round((1 - i0.value / i1.value) * 100, 1) : null;
  const sharesYoY = s0 && s1 && s1.value > 0 ? round((s0.value / s1.value - 1) * 100, 1) : null;
  // Yahoo can lag a fresh report by days. If the newest quarter on file ended
  // long before the release, these numbers describe the PREVIOUS report. A
  // quarter is ~91 days and releases come 2-12 weeks after it ends, so the
  // previous quarter is ~105+ days old on release day; 100 keeps it out while a
  // late 10-K (up to ~90 days) still counts.
  const stale = eventDate ? daysBetween(period, eventDate) > (cfg.maxStaleDays || 100) : false;

  const reasons = [];
  if (isNum(revenueYoY) && revenueYoY >= cfg.minRevenueYoYPct) reasons.push('revenue +' + revenueYoY + '% YoY');
  if (turnedProfitable) reasons.push('net income turned positive');
  if (isNum(lossNarrowedPct) && lossNarrowedPct >= cfg.minLossNarrowPct && (revenueYoY === null || revenueYoY >= 0)) {
    reasons.push('net loss narrowed ' + lossNarrowedPct + '% YoY');
  }

  const facts = [];
  if (r0) facts.push('Revenue $' + short(r0.value) + (r1 ? ' vs $' + short(r1.value) + ' a year earlier' + (isNum(revenueYoY) ? ' (' + (revenueYoY > 0 ? '+' : '') + revenueYoY + '%)' : '') : ''));
  if (i0) facts.push('Net income $' + short(i0.value) + (i1 ? ' vs $' + short(i1.value) + ' a year earlier' : ''));
  if (s0 && s1) facts.push('Shares ' + short(s0.value) + ' vs ' + short(s1.value) + ' a year earlier (' + (sharesYoY > 0 ? '+' : '') + sharesYoY + '%)');
  if (c0) facts.push('Cash $' + short(c0.value) + ' at ' + c0.asOfDate);

  return {
    period: 'quarter ended ' + period, periodEnd: period, source: 'Yahoo Finance fundamentals',
    revenue: r0 ? r0.value : null, revenueYearAgo: r1 ? r1.value : null, revenueYoY: revenueYoY,
    netIncome: i0 ? i0.value : null, netIncomeYearAgo: i1 ? i1.value : null,
    turnedProfitable: turnedProfitable, lossNarrowedPct: lossNarrowedPct,
    shares: s0 ? s0.value : null, sharesYoY: sharesYoY, cash: c0 ? c0.value : null,
    stale: stale, qualifies: !stale && reasons.length > 0, reasons: reasons, facts: facts,
  };
}

// --- events ------------------------------------------------------------------------------
// Yahoo tags a story with every ticker it mentions — a Best Buy earnings piece
// arrives tagged FOSL. A story counts for a company only if the headline names
// it: the ticker as a word, or the company's name.
const NAME_SUFFIX = /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|group|n\s?v|s\s?a|ag|se|llc|lp|trust|technologies|international|intl|the)\b/gi;
const GENERIC = new Set(['first', 'american', 'global', 'united', 'national', 'new', 'general', 'advanced', 'applied',
  'digital', 'energy', 'capital', 'financial', 'health', 'healthcare', 'medical', 'pharma', 'therapeutics', 'sciences',
  'systems', 'solutions', 'industries', 'resources', 'partners', 'one', 'china', 'north', 'south', 'west', 'east', 'smart', 'bio']);
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function nameStems(name) {
  const words = String(name || '').replace(/[,.()'’&]/g, ' ').replace(NAME_SUFFIX, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const stems = [];
  if (words.length >= 2) stems.push(words.slice(0, 2).join(' '));
  if (words[0] && words[0].length >= 4 && !GENERIC.has(words[0].toLowerCase())) stems.push(words[0]);
  if (words.length === 1 && words[0].length >= 3) stems.push(words[0]);
  return stems;
}
function aboutCompany(headline, ticker, name) {
  const h = String(headline || '');
  const t = String(ticker || '');
  if (t.length >= 3 && new RegExp('(^|[^A-Za-z])' + escRe(t) + '([^A-Za-z]|$)').test(h)) return true;
  const low = h.toLowerCase();
  return nameStems(name).some((st) => new RegExp('(^|[^a-z])' + escRe(st.toLowerCase()) + '([^a-z]|$)').test(low));
}

function newsEvents(items, window, subject) {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  return (items || [])
    .filter((it) => it.publishedAt && Date.parse(it.publishedAt) >= from && Date.parse(it.publishedAt) <= to)
    .filter((it) => !subject || aboutCompany(it.title, subject.ticker, subject.name))
    .map((it) => {
      const c = classify(it.title);
      return {
        date: nyDate(it.publishedAt), at: it.publishedAt, origin: 'news', publisher: it.publisher,
        sourceClass: sourceClass(it.publisher), headline: it.title, url: it.url,
        type: c.type, tone: c.tone, tags: c.tags,
      };
    });
}

// When a filing was accepted. EDGAR is open 06:00-22:00 New York time. The 8-K
// feed's timestamps carry their offset (feedTime). The submissions API's
// acceptanceDateTime ends in "Z" but has been New York wall-clock time on some
// filings and true UTC on others, so reading it one way can be 4-5 hours off.
// Returns the readings that fall inside EDGAR's hours: one when that settles
// it, both when it does not.
const EDGAR_OPEN_MIN = 6 * 60;
const EDGAR_CLOSE_MIN = 22 * 60;
function edgarTimes(f) {
  if (f.feedTime) return [Date.parse(f.feedTime)];
  const s = String(f.acceptance || '').trim();
  if (!s) return f.filingDate ? [Date.parse(f.filingDate + 'T12:00:00Z')] : [];
  if (/[+-]\d\d:?\d\d$/.test(s)) return [Date.parse(s)];
  const asUtc = Date.parse(/Z$/i.test(s) ? s : s + 'Z');
  if (!isNum(asUtc)) return [];
  const asNy = F.fromNyWallClock(s);
  const open = (t) => { const m = F.nyMinutes(t); return m >= EDGAR_OPEN_MIN && m < EDGAR_CLOSE_MIN; };
  const both = [asUtc, asNy].filter(open);
  return both.length ? both : [asUtc, asNy];
}

function secEvents(filings, window) {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  return (filings || [])
    .map((f) => ({ f: f, times: edgarTimes(f) }))
    // Kept if either reading is in the window: a filing near the edge can show
    // in two runs, but an after-hours 8-K is never lost to a mislabelled clock.
    .filter((x) => x.times.some((t) => t >= from && t <= to))
    .map((x) => {
      const f = x.f;
      // A time is shown only when it is settled; otherwise just the filing date.
      const at = x.times.length === 1 && (f.feedTime || f.acceptance) ? new Date(x.times[0]).toISOString() : null;
      let d = { label: f.description || f.form, tone: 'neutral', earnings: false };
      if (/^8-K/.test(f.form)) d = describe8K(f.items);
      else if (DILUTION_FORMS.test(f.form)) d = { label: 'registration / prospectus', tone: 'dilution', earnings: false };
      else if (/^10-[QK]/.test(f.form)) d = { label: 'periodic report', tone: 'neutral', earnings: true };
      return {
        date: f.filingDate, at: at, origin: 'sec', publisher: 'SEC EDGAR', sourceClass: 'SEC filing',
        headline: f.form + ': ' + d.label, url: f.url, form: f.form, items: f.items || [],
        type: d.earnings ? 'earnings' : (d.tone === 'dilution' ? 'offering' : 'filing'), tone: d.tone, tags: [],
      };
    });
}

// The same release reaches Yahoo through several outlets. Keep one copy per
// headline, preferring the company's own wire release, then the earliest.
const RANK = { 'company release': 0, 'SEC filing': 0, media: 1, commentary: 2 };
function dedupeEvents(events) {
  const best = new Map();
  (events || []).forEach((e) => {
    const key = String(e.headline || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const cur = best.get(key);
    const better = !cur || (RANK[e.sourceClass] ?? 1) < (RANK[cur.sourceClass] ?? 1) ||
      ((RANK[e.sourceClass] ?? 1) === (RANK[cur.sourceClass] ?? 1) && String(e.at || '') < String(cur.at || ''));
    if (better) best.set(key, e);
  });
  return (events || []).filter((e) => best.get(String(e.headline || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()) === e);
}

// --- decision --------------------------------------------------------------------------
const WEAK_ONLY = ['analyst action', 'launch / milestone'];
// --- the same story told again --------------------------------------------------------
// A hit's news is re-reported for days ("Update: ...", "Why X stock soared", a
// second outlet, the 10-Q after the earnings release). A later positive event
// counts as new only if it is a different story from the stock's earlier hits.
// A story is its content words: the company name, the ticker, filler and price-
// move words left out, light stemming. It repeats an earlier hit when two thirds
// of its words were in that hit's headline and its specific tokens (amounts,
// product codes, quarters) do not contradict it: "$5M order" after "$3M order"
// is a new order.
const STORY_FILLER = new Set((
  'a an the of for to in on at by with from and or as its it is are was be been has have had that this these those ' +
  'into over after before amid following per via vs than then about new more just now here why what how who ' +
  'inc corp corporation co company companies ltd limited plc llc sa nv ag holdings holding group u.s us ' +
  'nasdaq nyse amex otc ticker stock stocks share shares investor investors news update updated breaking alert ' +
  'say says said announce announces announced announcing report reports reported reporting ' +
  'receive receives received receiving grant grants granted win wins won secure secures secured sign signs signed ' +
  'ink inks inked land lands landed get gets got obtain obtains obtained achieve achieves achieved ' +
  'rise rises rose rising jump jumps jumped jumping soar soars soared soaring surge surges surged surging ' +
  'rally rallies rallied climb climbs climbed gain gains gained spike spikes spiked pop pops popped ' +
  'skyrocket skyrockets skyrocketed rocket rockets higher up sharply premarket pre-market intraday ' +
  'trading trade trades today tonight session after-hours hours week ' +
  'monday tuesday wednesday thursday friday saturday sunday jan feb mar apr may jun jul aug sep sept oct nov dec ' +
  'january february march april june july august september october november december million billion thousand'
).split(' '));
const STEM_SUFFIXES = ['ations', 'ation', 'ions', 'ion', 'ings', 'ing', 'als', 'al', 'ed', 'es', 's'];
function stem(t) {
  if (/\d/.test(t)) return t;
  let w = t;
  for (let i = 0; i < STEM_SUFFIXES.length; i++) {
    const suf = STEM_SUFFIXES[i];
    if (w.length - suf.length >= 4 && w.slice(-suf.length) === suf) { w = w.slice(0, -suf.length); break; }
  }
  return w.length > 4 && w.slice(-1) === 'e' ? w.slice(0, -1) : w;
}
const specificToken = (t) => /\d/.test(t) && !/%$/.test(t) && !/^(19|20)\d\d$/.test(t);
function storyWords(headline, subject) {
  const own = new Set(String((subject && subject.name) || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2));
  if (subject && subject.ticker) own.add(String(subject.ticker).toLowerCase());
  const text = String(headline || '').toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/\bus\$/g, '$')
    .replace(/\$?\s?(\d+(?:[.,]\d+)?)\s*(million|mln|mn|mm|m)\b/g, ' $1m ')
    .replace(/\$?\s?(\d+(?:[.,]\d+)?)\s*(billion|bln|bn|b)\b/g, ' $1b ')
    .replace(/\$(\d)/g, '$1');
  const words = [];
  text.replace(/[^a-z0-9.%-]+/g, ' ').split(' ').forEach((raw) => {
    const t = raw.replace(/^[.-]+|[.-]+$/g, '');
    if (!t || /%$/.test(t) || STORY_FILLER.has(t) || own.has(t)) return;
    const w = stem(t);
    if (STORY_FILLER.has(w) || words.indexOf(w) !== -1) return;
    words.push(w);
  });
  return words;
}
// Same word, or one a prefix of the other ("termin" / "terminat").
const sameWord = (a, b) => a === b || (Math.min(a.length, b.length) >= 5 && (a.indexOf(b) === 0 || b.indexOf(a) === 0));
function repeatOf(headline, earlier, subject) {
  const mine = storyWords(headline, subject);
  if (!mine.length) return null;
  const mineSpecific = mine.filter(specificToken);
  for (let i = 0; i < (earlier || []).length; i++) {
    const theirs = storyWords(earlier[i].headline, subject);
    const shared = mine.filter((w) => theirs.some((x) => sameWord(w, x))).length;
    if (shared * 3 < mine.length * 2) continue;
    const theirSpecific = theirs.filter(specificToken);
    if (mineSpecific.length && theirSpecific.length && !mineSpecific.some((t) => theirSpecific.indexOf(t) !== -1)) continue;
    return earlier[i];
  }
  return null;
}

function decide(c, cfg) {
  cfg = cfg || DEFAULTS;
  const ev = c.events || [];
  // Two outlets describing one print differently ("loss widens" vs "beats
  // revenue estimates") is a contested print, not good news on its own.
  const contested = ev.some((e) => e.type === 'earnings' && (e.tone === 'negative' || e.tone === 'mixed'));
  // The stock's earlier hits in the follow-up window: their stories are not news again.
  const f = c.followUp || null;
  const earlier = f ? (f.stories && f.stories.length ? f.stories : (f.headline ? [{ headline: f.headline, url: f.url || null }] : [])) : [];
  const subject = { ticker: c.ticker, name: (c.metrics && c.metrics.name) || (f && f.name) || '' };
  const repeats = [];
  const positives = ev.filter((e) => e.tone === 'positive' && e.sourceClass !== 'commentary' &&
    !(contested && e.type === 'earnings')).filter((e) => {
    const of = earlier.length ? repeatOf(e.headline, earlier, subject) : null;
    if (of) repeats.push({ headline: e.headline, url: e.url || null, publisher: e.publisher || null, at: e.at || e.date || null, sameAs: of.headline });
    return !of;
  });
  // An analyst's upgrade or a product launch is the weakest kind of "good news":
  // listed as a weak signal, but never enough on its own to add a name.
  const strongPositives = positives.filter((e) => WEAK_ONLY.indexOf(e.type) === -1);
  // Same bar as hits: an auto-generated summary is not a source for bad news either.
  const negatives = ev.filter((e) => (e.tone === 'dilution' || e.tone === 'negative') && e.sourceClass !== 'commentary');
  const hasEarnings = ev.some((e) => e.type === 'earnings');
  const fin = c.financials;
  // The same quarter reported again (the 10-Q days after the release, another
  // outlet's write-up) is not a new financial hit. A stock does not report two
  // quarters inside the follow-up window, so an earlier financial hit there with
  // an unknown period counts as the same quarter.
  const finSeen = !!(f && (f.financialHits || []).some((x) => !x.period || !fin || !fin.period || x.period === fin.period));
  const finRepeat = !!(hasEarnings && fin && fin.qualifies && finSeen);
  if (finRepeat) repeats.push({ headline: 'financials: ' + fin.reasons.join(', ') + ' (' + fin.period + ')', financials: true, sameAs: f.headline || null });
  const finHit = !!(hasEarnings && fin && fin.qualifies) && !finRepeat;
  const why = [];
  positives.slice(0, 3).forEach((e) => why.push(e.type + ': ' + e.headline));
  if (finHit) why.push('financials: ' + fin.reasons.join(', ') + ' (' + fin.period + ')');
  return { hit: strongPositives.length > 0 || finHit, weakOnly: !finHit && !strongPositives.length && positives.length > 0,
    finHit: finHit, contested: contested, positives: positives, negatives: negatives, why: why, repeats: repeats };
}

// The most relevant reported move for this run: extended hours when the run
// sits outside the session, else the regular-session change.
function reaction(k) {
  const ext = [k.postMarketChangePct, k.preMarketChangePct].filter(isNum);
  return { regular: n(k.changePct), extended: ext.length ? ext[0] : null };
}

// Display order only — not a rating. Primary-source positive events first,
// then the size of the price reaction, then the smaller share base.
const WEAK = ['launch / milestone', 'analyst action', 'partnership'];
const strong = (e) => WEAK.indexOf(e.type) === -1;
function order(a, b) {
  const st = (x) => x.decision.positives.filter(strong).length + (x.decision.finHit ? 1 : 0);
  const prim = (x) => x.decision.positives.filter((e) => e.sourceClass === 'company release' || e.sourceClass === 'SEC filing').length;
  if (st(b) !== st(a)) return st(b) - st(a);
  const mv = (x) => Math.max(Math.abs(x.reaction.regular || 0), Math.abs(x.reaction.extended || 0));
  const base = (x) => n(x.metrics.floatShares) || n(x.metrics.sharesOutstanding) || Infinity;
  return (prim(b) - prim(a)) || (b.decision.positives.length - a.decision.positives.length) || (mv(b) - mv(a)) || (base(a) - base(b));
}

module.exports = {
  DEFAULTS, config, isCommonListing, qualify, prefilter, classify, sourceClass, describe8K, dilutionCheck,
  financialDeltas, newsEvents, secEvents, edgarTimes, decide, reaction, order, nyDate, short, daysBetween,
  aboutCompany, nameStems, dedupeEvents, rankFilers, pickCandidates, storyWords, repeatOf, shareHistory,
};
