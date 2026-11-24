'use strict';
// Renders the scan as one continuous-form batch report: green-bar paper with
// tractor-feed margins, a dot-matrix masthead, highlighter marks for event tone,
// and the scheduled run's source checks written in red pen in the margin.
//
// Pure function of its inputs (latest report, run history, optional review), so
// bin/build.js and the tests render exactly the same page.

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? esc(u) : '');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function big(v) {
  if (!isNum(v)) return null;
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return Math.round(v / 1e3) + 'K';
  return String(Math.round(v));
}
const pct = (v) => (isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(1) + '%' : null);
const pad3 = (n) => String(isNum(n) ? n : 0).padStart(3, '0');

const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ET_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ET_DOW = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
const et = (iso) => (iso ? ET.format(new Date(iso)).replace(',', '') + ' ET' : '');
const etTime = (iso) => (iso ? ET_TIME.format(new Date(iso)) + ' ET' : '');

const TONE = { positive: 'pos', dilution: 'neg', negative: 'neg', mixed: 'mix', neutral: 'neu', noise: 'neu' };

// Dot leaders, the way a batch report lines up its parameters.
function leader(label, value, width) {
  const dots = Math.max(2, width - label.length - 1);
  return '<span class="lbl">' + esc(label) + ' ' + '.'.repeat(dots) + '</span> <b>' + value + '</b>';
}

function eventLine(e) {
  const href = safeUrl(e.url);
  const head = href ? '<a href="' + href + '" target="_blank" rel="noopener">' + esc(e.headline) + '</a>' : esc(e.headline);
  const caveat = (e.tags || []).filter((t) => t.indexOf(e.type + ' (') === 0).map((t) => t.replace(/^.*\((.*)\)$/, '$1'));
  return '<li class="ev"><span class="hl ' + (TONE[e.tone] || 'neu') + '">' + esc(String(e.type).toUpperCase()) + '</span> ' + head +
    '<span class="src">' + esc(e.publisher || e.sourceClass || '') + (e.at ? ' · ' + esc(et(e.at)) : e.date ? ' · ' + esc(e.date) : '') +
    (caveat.length ? ' · <i>' + esc(caveat.join(', ')) + '</i>' : '') + '</span></li>';
}

function penNote(review) {
  if (!review) return '';
  const mark = review.verdict === 'confirmed' ? '✓' : review.verdict === 'relabel' ? '✗' : '?';
  return '<aside class="pen ' + esc(review.verdict || 'unverified') + '" aria-label="Checked by the scheduled run">' +
    '<span class="mark">' + mark + '</span> ' + esc(review.note || review.verdict) + '</aside>';
}

function record(h, kind, review) {
  const m = h.metrics || {};
  const stats = [];
  const st = (html) => stats.push('<span class="st">' + html + '</span>');
  if (isNum(m.floatShares)) st('FLOAT <b>' + big(m.floatShares) + '</b>');
  if (isNum(m.sharesOutstanding)) st('SHS OUT <b>' + big(m.sharesOutstanding) + '</b>');
  if (isNum(m.marketCap)) st('CAP <b>$' + big(m.marketCap) + '</b>');
  if (isNum(m.price)) st('LAST <b>$' + (m.price >= 1 ? m.price.toFixed(2) : m.price.toFixed(4)) + '</b>');
  if (isNum(m.shortPercentOfFloat)) st('SHORT <b>' + m.shortPercentOfFloat.toFixed(1) + '%</b> OF FLOAT');
  const reg = h.reaction && pct(h.reaction.regular);
  const ext = h.reaction && pct(h.reaction.extended);
  const move = reg ? '<span class="move ' + (h.reaction.regular >= 0 ? 'up' : 'down') + '">' + esc(reg) + '</span>' : '';

  const events = (h.events || []).filter((e) => kind === 'neg' ? (e.tone === 'dilution' || e.tone === 'negative') : true).slice(0, 4);
  const lines = [];
  if (h.financials && h.financials.facts && h.financials.facts.length) {
    lines.push('<p class="line"><span class="key">FIN</span> ' + esc(h.financials.period) +
      (h.financials.stale ? ' — Yahoo still shows the previous quarter; not used' : '') + ': ' + esc(h.financials.facts.join(' · ')) + '</p>');
  }
  if (h.dilution && h.dilution.flagged) {
    lines.push('<p class="line dil"><span class="key">DIL</span> filings bearing on share count, last ' + esc(h.dilution.days) + ' days: ' +
      h.dilution.filings.map((f) => {
        const href = safeUrl(f.url);
        const label = esc(f.form + ' ' + f.date);
        return (href ? '<a href="' + href + '" target="_blank" rel="noopener">' + label + '</a>' : label) + ' <i>' + esc(f.why) + '</i>';
      }).join(' · ') + '</p>');
  }
  if (h.followUp) {
    lines.push('<p class="line"><span class="key">EARLIER</span> hit ' + esc(et(h.followUp.hitAt)) + ': ' + esc(h.followUp.headline || h.followUp.type || '') + '</p>');
  }
  if (h.qualifiesBy && h.qualifiesBy.length) {
    lines.push('<p class="line qual"><span class="key">WHY</span> ' + esc(h.qualifiesBy.join('; ')).replace(/&lt;=/g, '≤') + '</p>');
  }

  return '<article class="rec ' + kind + '">' +
    '<div class="rec-main">' +
      '<div class="rec-head"><span class="tk">' + esc(h.ticker) + '</span><span class="nm">' + esc(h.name || '') + '</span>' + move +
        (ext ? '<span class="ext">' + esc(ext) + ' EXT</span>' : '') + '</div>' +
      (stats.length ? '<p class="stats">' + stats.join('<span class="sep"> · </span>') + '</p>' : '') +
      '<ul class="evs">' + events.map(eventLine).join('') + '</ul>' +
      lines.join('') +
    '</div>' + penNote(review) +
  '</article>';
}

function section(letter, title, note, body) {
  return '<section class="sec"><header class="sec-head"><h2><span class="letter">' + letter + '</span>' + esc(title) + '</h2>' +
    (note ? '<p class="sec-note">' + note + '</p>' : '') + '</header>' + body + '</section>';
}

// Hits from earlier runs (last `days`), so the page is never blank between runs.
function earlierHits(history, latest, days) {
  const cutoff = Date.parse(latest.generatedAt) - days * 86400000;
  const shown = new Set((latest.hits || []).map((h) => h.ticker));
  const rows = [];
  ((history && history.runs) || []).forEach((run) => {
    if (run.generatedAt === latest.generatedAt || Date.parse(run.generatedAt) < cutoff) return;
    (run.hits || []).forEach((h) => {
      if (shown.has(h.ticker)) return;
      shown.add(h.ticker);
      rows.push({ run: run, h: h });
    });
  });
  return rows;
}

function earlierList(rows) {
  return '<ul class="earlier">' + rows.slice(0, 30).map((x) => {
    const h = x.h;
    const href = safeUrl(h.url);
    const head = href ? '<a href="' + href + '" target="_blank" rel="noopener">' + esc(h.headline || '') + '</a>' : esc(h.headline || '');
    const size = [isNum(h.floatShares) ? 'FLOAT ' + big(h.floatShares) : (isNum(h.sharesOutstanding) ? 'SHS ' + big(h.sharesOutstanding) : null),
      isNum(h.marketCap) ? 'CAP $' + big(h.marketCap) : null].filter(Boolean).join(' · ');
    return '<li><span class="when">' + esc(x.run.date) + ' ' + esc(String(x.run.run).toUpperCase()) + '</span>' +
      '<b class="etk">' + esc(h.ticker) + '</b> <span class="hl pos">' + esc(String(h.type || '').toUpperCase()) + '</span> ' + head +
      (size ? '<span class="src">' + esc(size) + (h.dilution ? ' · dilution filings on record' : '') + '</span>' : '') + '</li>';
  }).join('') + '</ul>';
}

function runLog(history) {
  const runs = (history && history.runs) || [];
  if (!runs.length) return '<p class="empty">NO EARLIER RUNS ON FILE.</p>';
  const rows = runs.slice(0, 24).map((r) => '<tr><td>' + esc(r.date) + '</td><td>' + esc(String(r.run).toUpperCase()) + '</td>' +
    '<td class="n">' + pad3(r.counts && r.counts.hits) + '</td><td class="n">' + pad3(r.counts && r.counts.dilutionOrNegative) + '</td>' +
    '<td class="tks">' + ((r.hits || []).map((h) => esc(h.ticker)).join(' ') || '—') + '</td>' +
    '<td>' + (r.sources && r.sources.yahoo ? 'OK' : 'DEGRADED') + '</td><td>' + (r.sources && r.sources.sec ? 'ON' : 'OFF') + '</td></tr>').join('');
  return '<div class="table-wrap"><table class="log"><thead><tr><th>DATE</th><th>PASS</th><th class="n">HITS</th><th class="n">DIL/NEG</th>' +
    '<th>TICKERS WITH HITS</th><th>FLOAT DATA</th><th>SEC</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function render(input) {
  const r = input.latest;
  const history = input.history || { runs: [] };
  const reviews = {};
  ((input.review && input.review.items) || []).forEach((it) => { if (it && it.ticker) reviews[String(it.ticker).toUpperCase()] = it; });

  if (!r) {
    return PAGE.replace('{{BODY}}', '<header class="masthead"><p class="job">JOB ROUTINE.SFSCAN</p><h1>SMALL-FLOAT SCAN</h1>' +
      '<p class="empty">NO RUN ON FILE YET. THE FIRST SCHEDULED PASS PRINTS HERE.</p></header>');
  }

  const s = r.sources || {};
  const yahoo = s.yahooSession && s.yahooSession.ok ? 'OK — FLOAT FROM KEY STATS' : 'DEGRADED — NO FLOAT THIS RUN';
  const sec = s.sec && s.sec.enabled ? (s.sec.ok === false ? 'FAILED' : 'ON · ' + (s.sec.filings8K || 0) + ' 8-KS') : 'OFF — NO SEC CONTACT SET';
  const cov = s.coverage || {};
  const partial = cov.newsMissed ? '<p class="partial">PARTIAL RUN — HEADLINES FOR ' + esc(cov.newsMissed) + ' QUALIFYING NAMES COULD NOT BE READ ' +
    '(YAHOO RATE LIMIT). THOSE NAMES WERE NOT CHECKED; THE HIT COUNT BELOW IS INCOMPLETE.</p>' : '';
  const c = r.counts || {};
  const dow = ET_DOW.format(new Date(r.generatedAt)).toUpperCase();
  const W = 13;
  const params = [
    [leader('RUN DATE', esc(r.date) + ' (' + dow + ')', W), leader('PASS', esc(String(r.run).toUpperCase()), W)],
    [leader('PRINTED', esc(etTime(r.generatedAt)), W), leader('WINDOW', esc(et(r.window && r.window.from)) + ' → ' + esc(etTime(r.window && r.window.to)), W)],
    [leader('CHECKED', pad3(c.candidates), W), leader('QUALIFIED', pad3(c.qualified), W)],
    [leader('HITS', pad3(c.hits), W), leader('DIL/NEG', pad3(c.dilutionOrNegative), W)],
    [leader('YAHOO', esc(yahoo), W), leader('SEC EDGAR', esc(sec), W)],
  ].map((row) => '<div class="prow"><span>' + row[0] + '</span><span>' + row[1] + '</span></div>').join('');

  const hits = r.hits || [];
  const negs = r.dilutionOrNegative || [];
  const after = negs.filter((h) => h.followUp);
  const plainNegs = negs.filter((h) => !h.followUp);
  const weak = r.weakSignals || [];

  const days = (s.followUps && s.followUps.days) || 10;
  const earlier = earlierHits(history, r, days);
  const parts = [];
  const letters = 'ABCDEFG';
  const add = (title, note, html) => parts.push(section(letters[parts.length], title, note, html));
  add('Hits', 'Positive-type events in the window. The type is a keyword label from the headline: where to look, not a rating.',
    hits.length ? hits.map((h) => record(h, 'pos', reviews[h.ticker])).join('') : '<p class="empty">NO QUALIFYING NAME HAD A POSITIVE-TYPE EVENT IN THIS WINDOW. ' + pad3(c.qualified) + ' NAMES CHECKED.</p>');
  if (after.length) add('After the good news', 'Earlier hits (last ' + esc(days) + ' days) that now have dilution or negative news.',
    after.map((h) => record(h, 'neg', reviews[h.ticker])).join(''));
  add('Dilution & negative', 'Offerings, ATMs, warrant deals, reverse splits, listing notices and setbacks on small floats in the window.',
    plainNegs.length ? plainNegs.slice(0, 16).map((h) => record(h, 'neg', reviews[h.ticker])).join('') : '<p class="empty">NONE IN THIS WINDOW.</p>');
  if (earlier.length) add('Earlier hits', 'From the previous runs of the last ' + esc(days) + ' days. Each is re-checked every run for follow-up dilution.',
    earlierList(earlier));
  if (weak.length) add('Weak signals', 'Analyst actions and product launches only. Listed, never counted as hits.',
    '<ul class="weak">' + weak.slice(0, 12).map((h) => {
      const e = (h.events || [])[0] || {};
      const href = safeUrl(e.url);
      return '<li><b>' + esc(h.ticker) + '</b> <span class="hl mix">' + esc(String(e.type || '').toUpperCase()) + '</span> ' +
        (href ? '<a href="' + href + '" target="_blank" rel="noopener">' + esc(e.headline) + '</a>' : esc(e.headline)) + '</li>';
    }).join('') + '</ul>');

  const body =
    '<header class="masthead">' +
      '<p class="job">JOB ROUTINE.SFSCAN · ' + esc(String(r.run).toUpperCase()) + ' PASS · US LISTED COMMON STOCK</p>' +
      '<h1><span class="nb">SMALL-FLOAT</span> SCAN</h1>' +
      '<p class="thesis">Good news and good financials on stocks with a float under 50M shares or a market cap under $300M. ' +
        'Twice a weekday. Every hit sits next to the dilution it may bring.</p>' +
      '<div class="params" role="group" aria-label="Run parameters">' + params + '</div>' + partial +
    '</header>' +
    parts.join('<div class="perf" aria-hidden="true"></div>') +
    '<div class="perf" aria-hidden="true"></div>' +
    section('·', 'Run log', 'One line per scheduled pass, newest first.', runLog(history)) +
    '<footer class="foot">' +
      '<p class="end">**** END OF REPORT ****</p>' +
      '<p>' + esc(r.criteria && r.criteria.rule ? 'Qualifies: ' + r.criteria.rule.replace(/<=/g, '≤') + '.' : '') + ' ' +
        esc(r.criteria && r.criteria.hit ? 'Hit: ' + r.criteria.hit.replace(/<=/g, '≤') + '.' : '') + '</p>' +
      '<p>Sources: Yahoo Finance key statistics, screener and headline feed (which carries GlobeNewswire, Business Wire, PR Newswire and ACCESS Newswire releases); ' +
        'SEC EDGAR filings when a contact is set. Red-pen notes are the scheduled run checking each hit against its source.</p>' +
      '<p>Not investment advice. Low-float good news is often followed by an offering.</p>' +
      '<p class="stamp">PRINTED ' + esc(new Date(r.generatedAt).toISOString().replace('T', ' ').slice(0, 16)) + ' UTC · ' +
        '<a href="https://github.com/mertonearth-arch/Routine" target="_blank" rel="noopener">github.com/mertonearth-arch/Routine</a></p>' +
    '</footer>';

  return PAGE.replace('{{BODY}}', body);
}

// Layout: one continuous-form sheet on a desk; tractor-feed strips down both
// edges, perforations between sections, red-pen notes in the right margin.
const PAGE = `<title>Small-Float Scan</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Doto:wght@800;900&display=swap">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Courier+Prime:ital,wght@0,400;0,700;1,400&display=swap">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;700&display=swap">
<style>
:root{
  /* green-bar continuous form, carbon ribbon ink, highlighters and a red pen */
  --desk:#D3DBD6; --paper:#FAFCF7; --band:#E2EEDD; --ink:#22292A; --ink-soft:#56625F; --rule:#A9BDA6;
  --hl-pos:#A8EB93; --hl-neg:#FFB0C4; --hl-mix:#FFE07A; --hl-neu:#E3E7E2; --pen:#C3261F; --up:#1D6B3C; --down:#B3261E;
  --dot:'Doto','Courier Prime','Courier New',monospace;
  --mono:'Courier Prime','Courier New',Courier,monospace;
  --hand:'Caveat','Segoe Print','Bradley Hand',cursive;
  --strip:30px; --line:1.5;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --desk:#0B100E; --paper:#151D1A; --band:#1B2622; --ink:#E1E8E0; --ink-soft:#9BAAA3; --rule:#3A4E46;
  --hl-pos:#2E6B39; --hl-neg:#7C2C45; --hl-mix:#6F5A16; --hl-neu:#26312C; --pen:#FF8F80; --up:#7FD49A; --down:#FF9B8F;
  color-scheme:dark;
}}
:root[data-theme="dark"]{
  --desk:#0B100E; --paper:#151D1A; --band:#1B2622; --ink:#E1E8E0; --ink-soft:#9BAAA3; --rule:#3A4E46;
  --hl-pos:#2E6B39; --hl-neg:#7C2C45; --hl-mix:#6F5A16; --hl-neu:#26312C; --pen:#FF8F80; --up:#7FD49A; --down:#FF9B8F;
  color-scheme:dark;
}
*{box-sizing:border-box}
body{margin:0;background:var(--desk);color:var(--ink);font-family:var(--mono);font-size:15px;line-height:var(--line);
  padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:28px 56px;
  font-variant-numeric:tabular-nums}
a{color:inherit;text-decoration:underline;text-decoration-color:var(--rule);text-underline-offset:3px;text-decoration-thickness:1px}
a:hover{text-decoration-color:var(--ink)}
:focus-visible{outline:2px solid var(--pen);outline-offset:2px}

/* the sheet: paper with green bands every three printed lines, tractor strips at both edges */
.sheet{position:relative;max-width:1060px;margin:0 auto;
  background:repeating-linear-gradient(to bottom,var(--band) 0 4.5em,var(--paper) 4.5em 9em);
  padding-block:28px 36px;padding-inline:calc(var(--strip) + 28px);
  box-shadow:0 1px 0 var(--rule),0 18px 40px -28px rgba(0,0,0,.45)}
.sheet::before,.sheet::after{content:"";position:absolute;top:0;bottom:0;width:var(--strip);
  background:radial-gradient(circle at 50% 12px,var(--desk) 0 5.5px,transparent 6px) 0 0/100% 24px repeat-y,var(--paper)}
.sheet::before{left:0;border-right:1px dashed var(--rule)}
.sheet::after{right:0;border-left:1px dashed var(--rule)}

/* masthead */
.masthead{display:flex;flex-direction:column;gap:10px;padding-bottom:22px;border-bottom:3px double var(--ink)}
.job{margin:0;font-size:12px;letter-spacing:.12em;color:var(--ink-soft)}
.masthead h1{margin:0;font-family:var(--dot);font-weight:900;font-size:clamp(2.1rem,6.2vw,4.1rem);line-height:1;letter-spacing:.04em;text-wrap:balance}
.thesis{margin:0;max-width:62ch;font-size:15px}
.params{display:grid;gap:2px;margin-top:6px;font-size:13.5px}
.prow{display:grid;grid-template-columns:1fr 1fr;gap:4px 28px}
.prow>span{min-width:0;overflow-wrap:anywhere}
.lbl{color:var(--ink-soft)}
.params b{font-weight:700}

/* sections */
.sec{display:flex;flex-direction:column;gap:14px;padding-top:24px}
.sec-head h2{margin:0;font-family:var(--dot);font-weight:900;font-size:1.55rem;letter-spacing:.05em;text-transform:uppercase;display:flex;gap:14px;align-items:baseline}
.letter{font-family:var(--mono);font-weight:700;font-size:1rem;border:1.5px solid var(--ink);padding:0 7px;line-height:1.5}
.sec-note{margin:4px 0 0;color:var(--ink-soft);font-size:13.5px;max-width:72ch}
.perf{height:0;border-top:2px dotted var(--rule);margin:28px calc(-1 * (var(--strip) + 28px)) 0}

/* a record: the hit itself on the left, the red-pen check in the margin */
.rec{display:grid;grid-template-columns:minmax(0,1fr) 190px;gap:8px 22px;padding:12px 0 14px;border-top:1px solid var(--rule)}
.rec:first-of-type{border-top:0}
.rec-main{min-width:0;display:flex;flex-direction:column;gap:6px}
.rec-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px}
.tk{font-weight:700;font-size:1.45rem;letter-spacing:.04em}
.nm{color:var(--ink-soft);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 12ch}
.move{font-weight:700;font-size:1.05rem}
.move.up{color:var(--up)} .move.down{color:var(--down)}
.ext{font-size:12.5px;color:var(--ink-soft)}
.stats{margin:0;font-size:13.5px;color:var(--ink-soft)}
.stats b{color:var(--ink)}
.st{white-space:nowrap}
.nb{white-space:nowrap}
.sep{color:var(--rule)}
.evs{list-style:none;margin:2px 0 0;padding:0;display:flex;flex-direction:column;gap:7px}
.ev{overflow-wrap:anywhere}
.src{display:block;font-size:12.5px;color:var(--ink-soft);margin-top:1px}
.line{margin:0;font-size:13.5px;overflow-wrap:anywhere}
.line i{color:var(--ink-soft)}
.key{display:inline-block;min-width:4.5em;font-weight:700;letter-spacing:.06em}
.qual{color:var(--ink-soft)}

/* highlighter swipes: tone of the event, not a rating */
.hl{font-weight:700;font-size:12.5px;letter-spacing:.06em;padding:1px .45em;-webkit-box-decoration-break:clone;box-decoration-break:clone;
  border-radius:3px 8px 4px 9px;white-space:nowrap}
.hl.pos{background:linear-gradient(100deg,transparent 2px,var(--hl-pos) 4px,var(--hl-pos) calc(100% - 3px),transparent)}
.hl.neg{background:linear-gradient(100deg,transparent 2px,var(--hl-neg) 4px,var(--hl-neg) calc(100% - 3px),transparent)}
.hl.mix{background:linear-gradient(100deg,transparent 2px,var(--hl-mix) 4px,var(--hl-mix) calc(100% - 3px),transparent)}
.hl.neu{background:var(--hl-neu)}

/* red pen in the margin */
.pen{font-family:var(--hand);color:var(--pen);font-size:1.3rem;line-height:1.15;transform:rotate(-2.5deg);transform-origin:left top;
  align-self:start;padding-top:4px}
.pen .mark{font-weight:700;font-size:1.5rem}
.pen.relabel{transform:rotate(1.5deg)}

.empty{margin:0;padding:10px 0;letter-spacing:.06em;color:var(--ink-soft)}
.partial{margin:8px 0 0;padding:8px 12px;border:1.5px dashed var(--pen);color:var(--pen);font-weight:700;font-size:13.5px;letter-spacing:.04em;max-width:78ch}
.weak{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;font-size:14px}
.weak li{overflow-wrap:anywhere}
.earlier{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px;font-size:14px}
.earlier li{overflow-wrap:anywhere}
.when{display:inline-block;min-width:13ch;color:var(--ink-soft);font-size:12.5px}
.etk{margin-right:6px}

/* run log */
.table-wrap{overflow-x:auto}
.log{border-collapse:collapse;font-size:13.5px;min-width:640px;width:100%}
.log th{text-align:left;font-weight:700;letter-spacing:.08em;border-bottom:1.5px solid var(--ink);padding:4px 14px 4px 0;white-space:nowrap}
.log td{padding:3px 14px 3px 0;border-bottom:1px dotted var(--rule);white-space:nowrap}
.log .n{text-align:right}
.log .tks{white-space:normal;font-weight:700}

.foot{margin-top:30px;padding-top:16px;border-top:3px double var(--ink);display:flex;flex-direction:column;gap:8px;font-size:13px;color:var(--ink-soft);max-width:80ch}
.foot p{margin:0}
.end{color:var(--ink);font-weight:700;letter-spacing:.2em}
.stamp{font-size:12px;letter-spacing:.05em}

@media (max-width:720px){
  :root{--strip:16px}
  body{font-size:14px;padding-block:14px 40px}
  .sheet{padding-inline:calc(var(--strip) + 12px);padding-block:20px 28px}
  .sheet::before,.sheet::after{background:radial-gradient(circle at 50% 10px,var(--desk) 0 3.5px,transparent 4px) 0 0/100% 20px repeat-y,var(--paper)}
  .perf{margin-inline:calc(-1 * (var(--strip) + 12px))}
  .prow{grid-template-columns:1fr}
  .rec{grid-template-columns:minmax(0,1fr)}
  .pen{padding-top:0;margin-left:10px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>
<div class="sheet">
{{BODY}}
</div>`;

module.exports = { render, esc, safeUrl, big };
