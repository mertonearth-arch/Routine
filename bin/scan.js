#!/usr/bin/env node
'use strict';
// Small-float scan: good news and good financials on low-float and micro-cap US
// listings. Run twice a weekday by the scheduled routines (see ROUTINE.md).
//
//   node bin/scan.js --run am|pm [--since <ISO time>] [--out <dir>] [--history <file>]
//
// Reads  out/history.json  (previous runs; the routine downloads it from the page)
// Writes out/latest.json   (this run, in full)
//        out/history.json  (history with this run added)
//
// A name qualifies on float <= 50M shares (shares outstanding <= 50M also counts,
// since float can only be lower) or market cap <= $300M. Thresholds live in
// scan.config.json; the rules themselves in lib/scan.js.

// Behind an HTTPS proxy (the cloud sandbox), Node's fetch only uses it when
// started with NODE_USE_ENV_PROXY=1 (Node >= 22.21), so re-launch once with it.
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const r = require('child_process').spawnSync(process.execPath, ['--disable-warning=UNDICI-EHPA'].concat(process.argv.slice(1)), {
    stdio: 'inherit', env: Object.assign({}, process.env, { NODE_USE_ENV_PROXY: '1' }),
  });
  process.exit(r.status === null ? 1 : r.status);
}

const fs = require('fs');
const path = require('path');
const L = require('../lib/scan');
const Y = require('../lib/yahoo');
const SEC = require('../lib/sec');
const H = require('../lib/http');
const HIST = require('../lib/history');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i === -1 || i === args.length - 1 ? fallback : args[i + 1];
};

const nyHour = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(new Date()));
const run = flag('run', nyHour() < 12 ? 'am' : 'pm');
const OUT = path.resolve(flag('out', path.join(ROOT, 'out')));
const HISTORY_FILE = path.resolve(flag('history', path.join(OUT, 'history.json')));
const today = L.nyDate(new Date().toISOString());

function loadConfig() {
  const file = path.join(ROOT, 'scan.config.json');
  const over = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  delete over._comment;
  return L.config(over);
}

// The crumb endpoint rate-limits per IP (cloud IPs are shared) and per host, so
// alternate query2/query1 and back off — about 2.5 minutes at most.
async function yahooSession() {
  let last = null;
  const plan = [[0, Y.Q2], [2000, Y.Q1], [8000, Y.Q2], [15000, Y.Q1], [30000, Y.Q2], [45000, Y.Q1], [60000, Y.Q2]];
  for (const step of plan) {
    if (step[0]) await H.sleep(step[0]);
    try { return await Y.session(step[1]); } catch (e) { last = e; }
  }
  throw last;
}

const metricsFromQuote = (q) => ({
  name: q.longName || q.shortName || null, exchange: q.exchange || null, sector: null, industry: null,
  price: q.regularMarketPrice === undefined ? null : q.regularMarketPrice,
  changePct: q.regularMarketChangePercent === undefined ? null : q.regularMarketChangePercent,
  priceTime: q.regularMarketTime ? new Date(q.regularMarketTime * 1000).toISOString() : null,
  marketCap: q.marketCap === undefined ? null : q.marketCap,
  sharesOutstanding: q.sharesOutstanding === undefined ? null : q.sharesOutstanding,
  floatShares: null, metricsSource: 'Yahoo Finance screener quote',
});

// Hard ceiling on a run: a scheduled session's commands time out at 10 minutes.
// Past the budget, remaining lookups are recorded as unchecked, never guessed.
const BUDGET_MS = parseInt(process.env.SCAN_BUDGET_MS || String(8 * 60 * 1000), 10);
const START = Date.now();
const overBudget = () => Date.now() - START > BUDGET_MS;

async function main() {
  const cfg = loadConfig();
  const history = fs.existsSync(HISTORY_FILE) ? HIST.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) : HIST.empty();
  const window = HIST.scanWindow(history, {
    since: flag('since', null), capHours: cfg.lookbackHoursCap, overlapMinutes: cfg.overlapMinutes, defaultHours: cfg.defaultLookbackHours,
  });
  const sources = {};
  const errors = [];
  const err = (ticker, step, e) => errors.push({ ticker: ticker, step: step, error: String(e && e.message ? e.message : e).slice(0, 200) });

  // 1. Session -----------------------------------------------------------------------
  let sess = null;
  try { sess = await yahooSession(); sources.yahooSession = { ok: true }; }
  catch (e) { sources.yahooSession = { ok: false, error: e.message, effect: 'no float data and no custom screen this run; fell back to a smaller Yahoo screen' }; }

  // 2. Universe ------------------------------------------------------------------------
  const quotes = [];
  if (sess) {
    const query = { operator: 'AND', operands: [
      { operator: 'or', operands: cfg.exchanges.map((x) => ({ operator: 'eq', operands: ['exchange', x] })) },
      { operator: 'lt', operands: ['intradaymarketcap', cfg.floatRouteMaxMarketCap] },
      { operator: 'gt', operands: ['percentchange', cfg.minChangePct] },
    ] };
    let total = 0;
    try {
      for (let page = 0; page < cfg.screenPages; page++) {
        const r = await Y.screen(sess, query, { offset: page * 250 });
        total = r.total;
        quotes.push.apply(quotes, r.quotes);
        if (r.quotes.length < 250) break;
      }
      sources.screen = { ok: true, kind: 'custom', total: total, returned: quotes.length,
        query: 'Nasdaq/NYSE/NYSE American, market cap < $' + L.short(cfg.floatRouteMaxMarketCap) + ', up > ' + cfg.minChangePct + '%' };
    } catch (e) { sources.screen = { ok: false, error: e.message }; }
  }
  if (!quotes.length) {
    try {
      const r = await Y.predefined('small_cap_gainers', 250);
      quotes.push.apply(quotes, r.quotes);
      sources.screen = Object.assign(sources.screen || {}, { fallback: 'Yahoo small_cap_gainers', returned: r.quotes.length });
    } catch (e) { sources.screenFallback = { ok: false, error: e.message }; }
  }

  // Candidates: earlier hits (follow-up), price movers and, with SEC on, the
  // window's 8-K filers, chosen within maxCandidates by L.pickCandidates.
  const cand = new Map();
  const add = (ticker, from, seed) => {
    const t = String(ticker || '').toUpperCase();
    if (!t) return;
    if (!cand.has(t)) cand.set(t, { ticker: t, from: [], quote: null, cik: null, followUp: null });
    const c = cand.get(t);
    if (c.from.indexOf(from) === -1) c.from.push(from);
    if (seed && seed.quote) c.quote = seed.quote;
    if (seed && seed.cik) c.cik = seed.cik;
    if (seed && seed.followUp) c.followUp = seed.followUp;
  };
  const up = (t) => String(t || '').toUpperCase();

  const earlier = HIST.recentHits(history, cfg.followUpDays);
  const followOf = new Map();
  earlier.forEach((e) => { if (!followOf.has(up(e.ticker))) followOf.set(up(e.ticker), e); });
  sources.followUps = { recentHits: earlier.length, days: cfg.followUpDays };

  const quoteOf = new Map(); // movers, in screen order (biggest move first)
  quotes.filter((q) => L.prefilter(q, cfg)).forEach((q) => { if (!quoteOf.has(up(q.symbol))) quoteOf.set(up(q.symbol), q); });
  sources.screen = Object.assign(sources.screen || {}, { passedPrefilter: quoteOf.size });

  // SEC: who filed an 8-K in the window. Filers that are not movers are sized
  // with one batch quote per 50 names and put through the movers' filter.
  let cikMap = null;
  const feedTimes = new Map(); // accession -> the feed's timestamp, which carries its offset
  const filerInfo = new Map(); // ticker -> { cik, items }
  const sized = new Map();     // ticker -> batch quote
  let rankedFilers = [];
  if (SEC.enabled()) {
    try {
      cikMap = await SEC.cikMap();
      const filings = await SEC.recent8Ks(window.from, 6);
      filings.forEach((f) => {
        if (f.accession && f.at) feedTimes.set(f.accession, f.at);
        const t = f.cik !== null ? cikMap.byCik[f.cik] : null;
        if (!t) return;
        const info = filerInfo.get(t) || { cik: f.cik, items: [] };
        (f.items || []).forEach((i) => { if (info.items.indexOf(i) === -1) info.items.push(i); });
        filerInfo.set(t, info);
      });
      sources.sec = { enabled: true, filings8K: filings.length, filers: filerInfo.size };
    } catch (e) { sources.sec = { enabled: true, ok: false, error: e.message }; }
  } else {
    sources.sec = { enabled: false, reason: SEC.disabledReason() };
  }
  if (filerInfo.size) {
    const toSize = Array.from(filerInfo.keys()).filter((t) => !quoteOf.has(t) && !followOf.has(t));
    if (sess && toSize.length) {
      try { (await Y.quotes(sess, toSize)).forEach((q) => sized.set(up(q.symbol), q)); }
      catch (e) { sources.sec.sizingError = e.message; }
    } else if (toSize.length) {
      sources.sec.note = 'no Yahoo session: ' + toSize.length + ' 8-K filers that did not move could not be sized and were not checked';
    }
    const eligible = [];
    filerInfo.forEach((info, t) => {
      const q = quoteOf.get(t) || sized.get(t);
      if (q && (!q.quoteType || q.quoteType === 'EQUITY') && L.prefilter(q, cfg)) eligible.push({ ticker: t, items: info.items, quote: q });
    });
    rankedFilers = L.rankFilers(eligible);
    sources.sec.sized = sized.size;
    sources.sec.eligible = eligible.length;
  }

  const pick = L.pickCandidates(Array.from(followOf.keys()), Array.from(quoteOf.keys()), rankedFilers, cfg);
  pick.earlier.forEach((t) => add(t, 'earlier hit', { followUp: followOf.get(t), quote: quoteOf.get(t) }));
  pick.movers.forEach((t) => add(t, 'mover', { quote: quoteOf.get(t) }));
  pick.filers.forEach((t) => add(t, 'sec 8-K', { quote: quoteOf.get(t) || sized.get(t) }));
  cand.forEach((c) => {
    if (quoteOf.has(c.ticker) && c.from.indexOf('mover') === -1) c.from.push('mover');
    const info = filerInfo.get(c.ticker);
    if (!info) return;
    c.cik = info.cik;
    if (c.from.indexOf('sec 8-K') === -1) c.from.push('sec 8-K');
  });
  if (sources.sec.enabled && sources.sec.ok !== false) {
    sources.sec.filersChecked = Array.from(cand.values()).filter((c) => c.cik).length;
    sources.sec.nonMoversAdded = pick.filers.filter((t) => !quoteOf.has(t)).length;
  }

  const universe = new Set([].concat(Array.from(followOf.keys()), Array.from(quoteOf.keys()), rankedFilers)).size;
  const candidates = Array.from(cand.values());

  // 3. Metrics: float, shares, cap -----------------------------------------------------
  // Key stats cost one Yahoo request per name, and Yahoo throttles bursts. The
  // screener quote already carries shares outstanding and market cap, so key
  // stats are fetched only where float can change the answer (share count over
  // the line, cap between $300M and $2B), for names with no quote, and later for
  // the names that make the report, so their float is shown.
  const statsFor = async (c) => {
    if (!sess || c.statsFetched) return;
    if (overBudget()) { err(c.ticker, 'key stats', 'skipped: run time budget reached'); return; }
    try {
      c.metrics = Object.assign(await Y.keyStats(sess, c.ticker), { metricsSource: 'Yahoo Finance key statistics' });
      c.statsFetched = true;
    } catch (e) { err(c.ticker, 'key stats', e); }
  };
  candidates.forEach((c) => { if (c.quote) c.metrics = metricsFromQuote(c.quote); });
  const floatMatters = (m) => typeof m.sharesOutstanding === 'number' && m.sharesOutstanding > cfg.maxFloatShares &&
    (typeof m.marketCap !== 'number' || (m.marketCap > cfg.maxMarketCap && m.marketCap <= cfg.floatRouteMaxMarketCap));
  await H.mapLimit(candidates.filter((c) => !c.metrics || floatMatters(c.metrics)), 2, 300, statsFor);
  await H.mapLimit(candidates.filter((c) => !c.metrics), 2, 300, async (c) => {
    try {
      const sc = await Y.sharesAndCap(c.ticker);
      c.metrics = { name: (c.followUp && c.followUp.name) || null, exchange: null, price: null, changePct: null, floatShares: null,
        sharesOutstanding: sc.sharesOutstanding, sharesAsOf: sc.sharesAsOf, marketCap: sc.marketCap,
        metricsSource: 'Yahoo Finance fundamentals series (no key stats this run)' };
    } catch (e) { err(c.ticker, 'shares/cap', e); }
  });

  const excluded = [];
  const qualified = candidates.filter((c) => {
    if (!c.metrics) return false;
    if (c.metrics.exchange && !L.isCommonListing(c.ticker, c.metrics.exchange, cfg)) return false;
    if (c.metrics.quoteType && c.metrics.quoteType !== 'EQUITY') return false;
    const q = L.qualify(c.metrics, cfg);
    c.qualifiesBy = q.by;
    if (!q.ok && q.excluded) excluded.push({ ticker: c.ticker, reason: q.excluded });
    // An earlier hit stays on the follow-up list even if its cap has since grown.
    return q.ok || !!c.followUp;
  });

  // 4. Events: SEC filings and headlines side by side (different hosts, so
  // neither waits on the other's rate limit), then financials where there was
  // a report --------------------------------------------------------------------
  const withCik = SEC.enabled() && cikMap ? qualified.filter((c) => {
    if (!c.cik && cikMap.byTicker[c.ticker]) c.cik = cikMap.byTicker[c.ticker].cik;
    return !!c.cik;
  }) : [];
  const secStep = H.mapLimit(withCik, 2, 150, async (c) => {
    if (overBudget()) { err(c.ticker, 'sec submissions', 'skipped: run time budget reached'); return; }
    try {
      // The 8-K feed's time, where it has this filing, settles when it was accepted.
      const filings = (await SEC.submissions(c.cik))
        .map((f) => Object.assign(f, { feedTime: (f.accession && feedTimes.get(f.accession)) || null }));
      c.secEvents = L.secEvents(filings, window);
      c.dilution = L.dilutionCheck(filings, today, cfg);
    } catch (e) { err(c.ticker, 'sec submissions', e); }
  });
  const newsStep = H.mapLimit(qualified, 2, 350, async (c) => {
    if (overBudget()) { c.newsEvents = []; err(c.ticker, 'news', 'skipped: run time budget reached'); return; }
    try { c.newsEvents = L.newsEvents(await Y.news(c.ticker, cfg.newsPerTicker), window, { ticker: c.ticker, name: c.metrics.name }); }
    catch (e) { c.newsEvents = []; err(c.ticker, 'news', e); }
  });
  await Promise.all([secStep, newsStep]);
  qualified.forEach((c) => { c.events = (c.newsEvents || []).concat(c.secEvents || []); });

  const reporters = qualified.filter((c) => c.events.some((e) => e.type === 'earnings'));
  await H.mapLimit(reporters, 3, 150, async (c) => {
    const lastEarn = c.events.filter((e) => e.type === 'earnings').map((e) => e.date).sort().pop();
    try { c.finRaw = await Y.financials(c.ticker); c.financials = L.financialDeltas(c.finRaw, lastEarn, cfg); }
    catch (e) { err(c.ticker, 'financials', e); }
  });

  // 5. Decide ----------------------------------------------------------------------------
  qualified.forEach((c) => {
    c.events = L.dedupeEvents(c.events);
    c.events.sort((a, b) => String(b.at || b.date).localeCompare(String(a.at || a.date)));
    c.decision = L.decide(c, cfg);
    c.reaction = L.reaction(c.metrics);
  });
  // Names that make the report get their float and short interest shown.
  const reported = qualified.filter((c) => c.decision.hit || c.decision.negatives.length || c.decision.weakOnly);
  await H.mapLimit(reported, 2, 300, statsFor);
  // Dilution history for the names on the page (hits first): share count over
  // ~18 months and reverse splits, from Yahoo, so it shows even without SEC.
  const forHistory = reported.slice().sort((a, b) => (b.decision.hit ? 1 : 0) - (a.decision.hit ? 1 : 0)).slice(0, 25);
  await H.mapLimit(forHistory, 2, 300, async (c) => {
    if (overBudget()) { err(c.ticker, 'share history', 'skipped: run time budget reached'); return; }
    try {
      if (!c.finRaw) c.finRaw = await Y.financials(c.ticker);
      c.shareHistory = L.shareHistory(c.finRaw.OrdinarySharesNumber, await Y.splits(c.ticker), today, cfg);
    } catch (e) { err(c.ticker, 'share history', e); }
  });
  reported.forEach((c) => {
    const q = L.qualify(c.metrics, cfg);
    if (q.ok) c.qualifiesBy = q.by; // float known now: say so; it can only tighten the reason, never remove one
    c.reaction = L.reaction(c.metrics);
  });
  const num = (v) => (v === undefined ? null : v);
  const view = (c) => ({
    ticker: c.ticker, name: c.metrics.name, exchange: c.metrics.exchange, industry: c.metrics.industry || null,
    foundVia: c.from, qualifiesBy: c.qualifiesBy,
    metrics: {
      floatShares: num(c.metrics.floatShares), sharesOutstanding: num(c.metrics.sharesOutstanding), marketCap: num(c.metrics.marketCap),
      price: num(c.metrics.price), changePct: c.metrics.changePct == null ? null : Number(Number(c.metrics.changePct).toFixed(2)),
      preMarketChangePct: num(c.metrics.preMarketChangePct), postMarketChangePct: num(c.metrics.postMarketChangePct),
      shortPercentOfFloat: num(c.metrics.shortPercentOfFloat), source: c.metrics.metricsSource,
    },
    reaction: c.reaction,
    why: c.decision.why,
    events: c.events.filter((e) => e.tone !== 'noise').slice(0, 8),
    noise: c.events.filter((e) => e.tone === 'noise').length,
    financials: c.financials || null,
    dilution: c.dilution || null,
    shareHistory: c.shareHistory || null,
    followUp: c.followUp || null,
  });

  const qualifiedNow = qualified.filter((c) => c.qualifiesBy && c.qualifiesBy.length);
  const hitList = qualifiedNow.filter((c) => c.decision.hit).sort(L.order);
  const negList = qualified.filter((c) => !c.decision.hit && c.decision.negatives.length);
  const weakList = qualifiedNow.filter((c) => c.decision.weakOnly && !c.decision.negatives.length);
  // Real (non-noise) headlines the rules did not label: the routine skims these,
  // because keyword rules miss some good news.
  // Earlier hits whose story was told again in this window: not counted as new,
  // listed so the page can say what was left out and why.
  const repeatList = qualified.filter((c) => !c.decision.hit && c.decision.repeats.length)
    .map((c) => ({ ticker: c.ticker, name: c.metrics.name, earlierHitAt: c.followUp ? c.followUp.hitAt : null,
      earlierHeadline: c.followUp ? c.followUp.headline : null, stories: c.decision.repeats.slice(0, 3) }));
  const otherNews = qualifiedNow.filter((c) => !c.decision.hit && !c.decision.negatives.length && !c.decision.weakOnly &&
    !c.decision.repeats.length &&
    c.events.some((e) => e.tone !== 'noise'))
    .map((c) => ({ ticker: c.ticker, name: c.metrics.name, contested: c.decision.contested,
      headlines: c.events.filter((e) => e.tone !== 'noise').slice(0, 3).map((e) => ({ date: e.date, at: e.at, type: e.type, tone: e.tone, publisher: e.publisher, headline: e.headline, url: e.url })) }));

  const report = {
    generatedAt: new Date().toISOString(), date: today, run: run, window: window,
    criteria: {
      maxFloatShares: cfg.maxFloatShares, maxMarketCap: cfg.maxMarketCap, floatRouteMaxMarketCap: cfg.floatRouteMaxMarketCap,
      rule: 'float <= ' + L.short(cfg.maxFloatShares) + ' shares (or shares outstanding <= ' + L.short(cfg.maxFloatShares) +
        ', which bounds float) with market cap <= $' + L.short(cfg.floatRouteMaxMarketCap) + '; or market cap <= $' + L.short(cfg.maxMarketCap),
      hit: 'a positive-type event in the window from a company release, SEC filing or news outlet (not commentary, not an analyst ' +
        'action or a product launch alone), or an earnings report showing revenue +' + cfg.minRevenueYoYPct + '% YoY, a turn to profit, or a loss narrowed ' + cfg.minLossNarrowPct + '%+',
      note: 'Event types are keyword labels from headlines. They mark where to look; they are not ratings.',
    },
    sources: sources,
    counts: { universe: universe, candidates: candidates.length, qualified: qualifiedNow.length, hits: hitList.length,
      dilutionOrNegative: negList.length, weakSignals: weakList.length, repeats: repeatList.length, otherNews: otherNews.length, errors: errors.length },
    hits: hitList.map(view),
    dilutionOrNegative: negList.map(view),
    weakSignals: weakList.map(view),
    repeatsOfEarlierHits: repeatList,
    otherNews: otherNews.slice(0, 40),
    excludedLargeLowShareCount: excluded.slice(0, 15),
    errors: errors.slice(0, 40),
  };

  // Names whose headlines could not be read are unchecked, not "no news":
  // say so on the page instead of letting the hit count look complete.
  const newsMissed = errors.filter((e) => e.step === 'news').length;
  const statsMissed = errors.filter((e) => e.step === 'key stats').length;
  const secMissed = errors.filter((e) => e.step === 'sec submissions').length;
  report.sources.coverage = { newsMissed: newsMissed, keyStatsMissed: statsMissed, secMissed: secMissed,
    throttleWaits: H.throttleStats.waits429, partial: newsMissed > 0 };

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'latest.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(HIST.appendRun(history, report)) + '\n');
  printDigest(report);
}

function printDigest(r) {
  const pct = (v) => (typeof v === 'number' ? (v > 0 ? '+' : '') + v.toFixed(1) + '%' : '   -  ');
  const sh = (m) => (m.floatShares != null ? 'float ' + L.short(m.floatShares)
    : m.sharesOutstanding != null ? 'shares ' + L.short(m.sharesOutstanding) : 'float ?');
  console.log('Small-float scan — ' + r.date + ' ' + r.run.toUpperCase() + '   window ' + r.window.from.slice(0, 16) + 'Z → ' + r.window.to.slice(0, 16) + 'Z (' + r.window.basis + ')');
  console.log('  universe ' + r.counts.universe + ' · checked ' + r.counts.candidates + ' · qualified ' + r.counts.qualified +
    ' · hits ' + r.counts.hits + ' · dilution/negative ' + r.counts.dilutionOrNegative + (r.counts.errors ? ' · errors ' + r.counts.errors : ''));
  const s = r.sources;
  console.log('  Yahoo session ' + (s.yahooSession.ok ? 'ok' : 'FAILED (' + s.yahooSession.error + ') — DEGRADED RUN: no float data, smaller universe') +
    ' · screen ' + (s.screen ? (s.screen.ok === false ? 'FAILED' : (s.screen.total || s.screen.returned || 0) + ' movers' + (s.screen.fallback ? ' (fallback ' + s.screen.fallback + ')' : '')) : 'none') +
    ' · SEC ' + (s.sec.enabled ? (s.sec.ok === false ? 'FAILED (' + s.sec.error + ')' : s.sec.filings8K + ' 8-Ks, ' + (s.sec.nonMoversAdded || 0) + ' filers that did not move checked') : 'skipped: ' + s.sec.reason));
  console.log('\nHITS (' + r.hits.length + ')' + (r.hits.length ? '' : '  — nothing qualifying in this window'));
  r.hits.forEach((h) => {
    const e = h.events.find((x) => x.tone === 'positive') || h.events[0];
    console.log('  ' + h.ticker.padEnd(6) + sh(h.metrics).padEnd(14) + ('$' + L.short(h.metrics.marketCap)).padEnd(9) +
      pct(h.reaction.regular).padStart(8) + '\n         ' +
      (e ? e.type + ' — ' + String(e.headline).slice(0, 110) + ' (' + (e.publisher || e.sourceClass) + ', ' + e.date + ')' : h.why[0]) +
      (h.financials && h.financials.qualifies ? '\n         financials: ' + h.financials.reasons.join(', ') + ' — ' + h.financials.period : '') +
      (h.dilution && h.dilution.flagged ? '\n         DILUTION FILINGS (' + h.dilution.days + 'd): ' + h.dilution.filings.map((f) => f.form + ' ' + f.date).join(', ') : ''));
  });
  if (r.dilutionOrNegative.length) {
    console.log('\nDILUTION / NEGATIVE (' + r.dilutionOrNegative.length + ')');
    r.dilutionOrNegative.slice(0, 15).forEach((h) => {
      const e = h.events.find((x) => x.tone === 'dilution' || x.tone === 'negative');
      console.log('  ' + h.ticker.padEnd(6) + (h.followUp ? '[earlier hit] ' : '') + (e ? e.type + ' — ' + String(e.headline).slice(0, 100) : ''));
    });
  }
  if ((r.repeatsOfEarlierHits || []).length) {
    console.log('\nNOT COUNTED — same story as an earlier hit (' + r.repeatsOfEarlierHits.length + ')');
    r.repeatsOfEarlierHits.forEach((x) => console.log('  ' + x.ticker.padEnd(6) + String(x.stories[0].headline).slice(0, 100)));
  }
  if (r.weakSignals.length) {
    console.log('\nWEAK SIGNALS ONLY — analyst actions / launches (' + r.weakSignals.length + ')');
    r.weakSignals.slice(0, 10).forEach((h) => { const e = h.events[0]; console.log('  ' + h.ticker.padEnd(6) + (e ? e.type + ' — ' + String(e.headline).slice(0, 100) : '')); });
  }
  console.log('\nwrote ' + path.relative(ROOT, path.join(OUT, 'latest.json')) + ' and ' + path.relative(ROOT, HISTORY_FILE));
}

main().catch((e) => { console.error('scan failed: ' + (e && e.stack ? e.stack : e)); process.exit(1); });
