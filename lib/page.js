'use strict';
// The report page ("Float Meter"): a grid-strict data poster. Oversized tickers, and
// each stock's float and market cap drawn to scale against the 50M / $300M lines, so
// why a name qualified is visible at a glance. Dilution and negative news sit in the
// same rows, in red; the scheduled run's source checks print under each hit.
//
// Pure function of its inputs (latest report, run history, optional review), so
// bin/build.js and the tests render exactly the same page.
const F = require('./format');
const { model } = require('./model');
const { esc, safeUrl, big, pct, money, isNum } = F;

const FLOAT_MAX = 100e6;  // track: 0–100M shares, line at 50M
const CAP_MAX = 1e9;      // track: $0–1B, line at $300M

function meter(label, value, max, line, fmt, lineLabel) {
  const has = isNum(value);
  const w = has ? Math.min(100, value / max * 100) : 0;
  const lp = line / max * 100;
  const under = has && value <= line;
  const over = has && value > max;
  return '<div class="meter"><div class="mlab"><span>' + esc(label) + '</span><b>' + (has ? esc(fmt(value)) : 'n/a') + '</b></div>' +
    '<div class="track" role="img" aria-label="' + esc(label + ' ' + (has ? fmt(value) : 'not available') + ', line at ' + lineLabel) + '">' +
      (has ? '<span class="fill' + (under ? '' : ' over') + '" style="width:' + w.toFixed(1) + '%' +
        (under ? '' : ';--cut:' + (line / Math.min(value, max) * 100).toFixed(1) + '%') + '"></span>' : '') +
      '<span class="line" style="left:' + lp.toFixed(1) + '%"><i>' + esc(lineLabel) + '</i></span>' +
      (over ? '<span class="more" aria-hidden="true">›</span>' : '') +
    '</div></div>';
}

function eventsList(evs) {
  return '<ul class="evs">' + evs.slice(0, 3).map((e) => '<li><span class="chip ' + esc(e.tone) + '">' + esc(e.type) + '</span>' +
    (e.url ? '<a href="' + esc(e.url) + '" target="_blank" rel="noopener">' + esc(e.headline) + '</a>' : esc(e.headline)) +
    '<span class="src">' + esc(e.publisher) + ' · ' + esc(e.when) + (e.caveat ? ' · ' + esc(e.caveat) : '') + '</span></li>').join('') + '</ul>';
}

function rowFor(it, kind) {
  const evs = kind === 'neg' ? it.events.filter((e) => e.tone === 'dilution' || e.tone === 'negative') : it.events;
  const extra = [];
  if (it.fin) extra.push('<p class="note"><b>Financials, ' + esc(it.fin.period) + '</b> ' + esc(it.fin.facts.join(' · ')) + (it.fin.stale ? ' (previous quarter on Yahoo; not used)' : '') + '</p>');
  if (it.dil) extra.push('<p class="note bad"><b>Dilution filings</b> ' + it.dil.map((f) => esc(f.form + ' ' + f.date) + ' — ' + esc(f.why)).join(' · ') + '</p>');
  if (it.followUp) extra.push('<p class="note"><b>Earlier hit</b> ' + esc(it.followUp.headline || '') + '</p>');
  if (it.review) extra.push('<p class="check ' + esc(it.review.verdict) + '"><b>' + (it.review.verdict === 'confirmed' ? '✓ Verified' : it.review.verdict === 'relabel' ? '✗ Relabel' : '? Unverified') + '</b> ' + esc(it.review.note) + '</p>');
  return '<article class="row ' + kind + '">' +
    '<div class="id"><h3>' + esc(it.ticker) + '</h3><p class="nm">' + esc(it.name) + '</p>' +
      '<p class="mv ' + (it.move >= 0 ? 'up' : 'down') + '">' + esc(pct(it.move) || '—') + (isNum(it.ext) ? ' <small>' + esc(pct(it.ext)) + ' ext</small>' : '') + '</p></div>' +
    '<div class="meters">' +
      meter(isNum(it.float) ? 'Float' : 'Shares out', isNum(it.float) ? it.float : it.so, FLOAT_MAX, 50e6, (x) => big(x), '50M') +
      meter('Market cap', it.cap, CAP_MAX, 300e6, (x) => money(x), '$300M') +
      (isNum(it.short) ? '<p class="minor">Short ' + esc(it.short.toFixed(1)) + '% of float' + (isNum(it.float) && isNum(it.so) ? ' · ' + esc(big(it.so)) + ' shares out' : '') + '</p>' : '') +
    '</div>' +
    '<div class="what">' + eventsList(evs) + extra.join('') + '</div>' +
  '</article>';
}

function render(input) {
  if (!input || !input.latest) {
    return PAGE.replace('{{BODY}}', '<main class="poster"><header class="top"><div class="name"><p class="kicker">Small-Float Scan</p>' +
      '<p class="thesis">No run on file yet. The first scheduled pass prints here.</p></div></header></main>');
  }
  const v = model(input);
  const R = v.run;
  const pad = (n) => String(n).padStart(2, '0');
  const sec = (title, note, html) => '<section class="sec"><header><h2>' + esc(title) + '</h2>' + (note ? '<p>' + note + '</p>' : '') + '</header>' + html + '</section>';
  const body = '<main class="poster">' +
    '<header class="top">' +
      '<div class="name"><p class="kicker">Small-Float Scan · ' + esc(R.pass) + ' pass</p>' +
        '<p class="thesis">Good news and good financials on US stocks with a float under 50M shares or a market cap under $300M. Twice a weekday.</p></div>' +
      '<div class="tally"><div class="n1"><b>' + pad(R.hits) + '</b><span>hits</span></div>' +
        '<div class="n2"><b>' + pad(R.negs) + '</b><span>dilution / negative</span></div>' +
        '<div class="n2"><b>' + R.qualified + '</b><span>qualified of ' + R.checked + ' checked</span></div></div>' +
      '<dl class="meta"><div><dt>Run</dt><dd>' + esc(R.date) + ' ' + esc(R.dow) + ' · ' + esc(R.printed) + '</dd></div>' +
        '<div><dt>Window</dt><dd>' + esc(R.from) + ' → ' + esc(R.to) + '</dd></div>' +
        '<div><dt>Float data</dt><dd>' + (R.yahooOk ? 'Yahoo key statistics' : '<b class="bad">unavailable</b>') + '</dd></div>' +
        '<div><dt>SEC EDGAR</dt><dd>' + (R.secOn ? 'on · ' + R.secFilings + ' 8-Ks' : '<b class="bad">off — no contact set</b>') + '</dd></div></dl>' +
      (R.partial ? '<p class="partial"><b>Partial run.</b> Headlines for ' + R.partial + ' qualifying names could not be read (rate limit); the hit count is incomplete.</p>' : '') +
      '<p class="legend"><span class="sw"></span>under the line <span class="sw over"></span>past the line &nbsp;·&nbsp; float on a 0–100M share scale, market cap on $0–1B. A stock qualifies when either bar stops short of its line.</p>' +
    '</header>' +
    sec('Hits', 'Positive-type events in the window. The type is a keyword label from the headline, not a rating.',
      v.hits.length ? v.hits.map((h) => rowFor(h, 'pos')).join('') : '<p class="none">No qualifying name had a positive-type event in this window.</p>') +
    (v.after.length ? sec('After the good news', 'Earlier hits that now have dilution or negative news.', v.after.map((h) => rowFor(h, 'neg')).join('')) : '') +
    sec('Dilution & negative', 'Offerings, ATMs, warrant deals, reverse splits, listing notices and setbacks on small floats.',
      v.negs.length ? v.negs.map((h) => rowFor(h, 'neg')).join('') : '<p class="none">None in this window.</p>') +
    (v.earlier.length || v.weak.length ? '<div class="' + (v.earlier.length && v.weak.length ? 'cols' : 'solo') + '">' +
      (v.earlier.length ? sec('Earlier hits', 'Last ' + R.days + ' days; re-checked every run.', '<ul class="list">' + v.earlier.map((x) => '<li><b>' + esc(x.h.ticker) + '</b><span>' + esc(x.h.type || '') + ' — ' +
        (safeUrl(x.h.url) ? '<a href="' + safeUrl(x.h.url) + '" target="_blank" rel="noopener">' + esc(x.h.headline) + '</a>' : esc(x.h.headline || '')) + '</span><i>' + esc(x.run.date + ' ' + String(x.run.run).toUpperCase()) + '</i></li>').join('') + '</ul>') : '') +
      (v.weak.length ? sec('Weak signals', 'Analyst actions and launches only.', '<ul class="list">' + v.weak.map((w) => '<li><b>' + esc(w.ticker) + '</b><span>' +
        esc((w.events[0] || {}).type || '') + ' — ' + esc((w.events[0] || {}).headline || '') + '</span></li>').join('') + '</ul>') : '') +
    '</div>' : '') +
    sec('Run log', '', !v.log.length ? '<p class="none">No earlier runs on file.</p>' : '<div class="tw"><table class="log"><thead><tr><th>Date</th><th>Pass</th><th class="n">Hits</th><th class="n">Dil/neg</th><th>Tickers</th><th>Float data</th><th>SEC</th></tr></thead><tbody>' +
      v.log.map((r) => '<tr><td>' + esc(r.date) + '</td><td>' + esc(String(r.run).toUpperCase()) + '</td><td class="n">' + ((r.counts && r.counts.hits) || 0) + '</td><td class="n">' +
        ((r.counts && r.counts.dilutionOrNegative) || 0) + '</td><td><b>' + ((r.hits || []).map((h) => esc(h.ticker)).join(' ') || '—') + '</b></td><td>' +
        (r.sources && r.sources.yahoo ? 'OK' : 'Degraded') + '</td><td>' + (r.sources && r.sources.sec ? 'On' : 'Off') + '</td></tr>').join('') + '</tbody></table></div>') +
    '<footer class="foot"><p><b>Qualifies</b> ' + esc(v.criteria.rule) + '.</p><p><b>Hit</b> ' + esc(v.criteria.hit) + '.</p>' +
      '<p>Checks (✓ ? ✗) are the scheduled run reading each hit\'s source. Not investment advice. Low-float good news is often followed by an offering.</p>' +
      '<p class="stamp">' + esc(R.printedUtc) + ' · github.com/mertonearth-arch/Routine</p></footer>' +
  '</main>';
  return PAGE.replace('{{BODY}}', body);
}

// Layout: 12-column poster grid; tally numerals top-left, run data top-right; one
// three-part row per stock (identity · meters · events) on strong rules.
const PAGE = `<title>Small-Float Scan</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap">
<style>
:root{
  /* cool white sheet, near-black ink, cobalt for "under the line", grey past it */
  --bg:#FBFBFC; --ink:#0E0F12; --soft:#5E6470; --hair:#D8DBE1; --track:#ECEEF2; --accent:#2B44FF; --over:#B8BECB;
  --good:#0A7A4B; --bad:#D12E2E; --mixed:#9A6A00;
  --sans:'Familjen Grotesk','Helvetica Neue',Arial,sans-serif; --mono:'JetBrains Mono',ui-monospace,Menlo,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#0C0D10; --ink:#F1F2F4; --soft:#9AA0AC; --hair:#2A2E37; --track:#1B1E25; --accent:#7D8BFF; --over:#4B5162;
  --good:#45D18F; --bad:#FF6B6B; --mixed:#E3B341; color-scheme:dark;
}}
:root[data-theme="dark"]{
  --bg:#0C0D10; --ink:#F1F2F4; --soft:#9AA0AC; --hair:#2A2E37; --track:#1B1E25; --accent:#7D8BFF; --over:#4B5162;
  --good:#45D18F; --bad:#FF6B6B; --mixed:#E3B341; color-scheme:dark;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.45;
  padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:30px 60px}
a{color:inherit;text-decoration-color:var(--hair);text-underline-offset:3px}
a:hover{text-decoration-color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.poster{max-width:1240px;margin:0 auto;display:flex;flex-direction:column;gap:34px}
.top{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:20px 24px;border-bottom:3px solid var(--ink);padding-bottom:22px}
.name{grid-column:1/6}
.kicker{margin:0;font-weight:700;letter-spacing:.16em;text-transform:uppercase;font-size:12px}
.thesis{margin:10px 0 0;font-size:1.25rem;line-height:1.3;font-weight:500;max-width:30ch;text-wrap:balance}
.tally{grid-column:6/10;display:grid;grid-template-columns:auto auto;gap:4px 22px;align-content:start}
.tally div{display:flex;flex-direction:column}
.tally b{font-family:var(--mono);font-weight:700;letter-spacing:-.04em;line-height:.9}
.n1{grid-row:span 2} .n1 b{font-size:clamp(4.5rem,11vw,8.5rem);color:var(--accent)}
.n2 b{font-size:2rem}
.tally span{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--soft)}
.meta{grid-column:10/13;margin:0;display:flex;flex-direction:column;gap:8px}
.meta div{border-top:1px solid var(--hair);padding-top:4px}
.meta dt{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--soft)}
.meta dd{margin:0;font-family:var(--mono);font-size:13px;overflow-wrap:anywhere}
.partial{grid-column:1/-1;margin:0;padding:10px 14px;border-left:4px solid var(--bad);background:var(--track);font-size:14px}
.legend{grid-column:1/-1;margin:0;font-size:13px;color:var(--soft);display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.sw{display:inline-block;width:22px;height:8px;background:var(--accent)} .sw.over{background:var(--over)}
.sec header{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 18px;margin-bottom:6px}
.sec h2{margin:0;font-size:2.2rem;font-weight:700;letter-spacing:-.02em;line-height:1}
.sec header p{margin:0;color:var(--soft);font-size:13.5px;max-width:70ch}
.row{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,4fr) minmax(0,5fr);gap:14px 28px;padding:18px 0 20px;border-top:2px solid var(--ink)}
.id{min-width:0}
.id h3{margin:0;font-size:clamp(2.6rem,5.5vw,4.2rem);font-weight:700;letter-spacing:-.035em;line-height:.92}
.nm{margin:6px 0 0;color:var(--soft);font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mv{margin:6px 0 0;font-family:var(--mono);font-weight:700;font-size:1.25rem}
.mv small{font-weight:400;font-size:12px;color:var(--soft)}
.up{color:var(--good)} .down{color:var(--bad)} .bad{color:var(--bad)}
.meters{display:flex;flex-direction:column;gap:14px;min-width:0}
.mlab{display:flex;justify-content:space-between;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:5px}
.mlab b{font-family:var(--mono);font-size:14px;letter-spacing:0;text-transform:none}
.track{position:relative;height:12px;background:var(--track)}
.fill{position:absolute;left:0;top:0;bottom:0;background:var(--accent)}
.fill.over{background:linear-gradient(90deg,var(--accent) 0 var(--cut,0%),var(--over) var(--cut,0%))}
.line{position:absolute;top:-5px;bottom:-5px;width:2px;background:var(--ink);transform:translateX(-1px)}
.line i{position:absolute;top:100%;left:50%;transform:translateX(-50%);margin-top:3px;font-style:normal;font-family:var(--mono);font-size:10.5px;color:var(--soft);white-space:nowrap}
.more{position:absolute;right:-14px;top:50%;transform:translateY(-55%);font-weight:700;color:var(--soft)}
.minor{margin:6px 0 0;font-size:12.5px;color:var(--soft);font-family:var(--mono)}
.what{min-width:0;display:flex;flex-direction:column;gap:8px}
.evs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.evs li{overflow-wrap:anywhere;font-size:15px;line-height:1.35}
.chip{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:2px 7px;margin-right:8px;color:var(--bg);background:var(--soft);vertical-align:2px}
.chip.positive{background:var(--good)} .chip.dilution,.chip.negative{background:var(--bad)} .chip.mixed{background:var(--mixed)}
.src{display:block;font-size:12px;color:var(--soft);margin-top:2px;font-family:var(--mono)}
.note{margin:0;font-size:13px;color:var(--soft);overflow-wrap:anywhere}
.note b{color:var(--ink);font-weight:700;margin-right:4px}
.note.bad b{color:var(--bad)}
.check{margin:0;font-size:13.5px;padding-left:10px;border-left:3px solid var(--good)}
.check.unverified{border-left-color:var(--mixed)} .check.relabel{border-left-color:var(--bad)}
.check b{margin-right:6px}
.row.neg .id h3{color:var(--bad)}
.none{margin:0;padding:14px 0;border-top:2px solid var(--ink);color:var(--soft)}
.cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:28px}
.solo{display:block}
.list{list-style:none;margin:0;padding:0;border-top:2px solid var(--ink)}
.list li{display:grid;grid-template-columns:64px minmax(0,1fr) auto;gap:10px;padding:8px 0;border-bottom:1px solid var(--hair);font-size:14px}
.list li span{min-width:0;overflow-wrap:anywhere} .list li i{font-style:normal;color:var(--soft);font-family:var(--mono);font-size:12px;white-space:nowrap}
.tw{overflow-x:auto;border-top:2px solid var(--ink)}
.log{width:100%;border-collapse:collapse;font-size:13.5px;min-width:620px;font-family:var(--mono)}
.log th{text-align:left;font-family:var(--sans);font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--soft);padding:8px 12px 6px 0;border-bottom:1px solid var(--hair)}
.log td{padding:6px 12px 6px 0;border-bottom:1px solid var(--hair)}
.log .n{text-align:right}
.foot{border-top:3px solid var(--ink);padding-top:14px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 28px;font-size:12.5px;color:var(--soft)}
.foot p{margin:0} .foot b{color:var(--ink)} .stamp{font-family:var(--mono)}
@media (max-width:860px){
  .name,.tally,.meta{grid-column:1/-1}
  .row{grid-template-columns:minmax(0,1fr)}
  .cols,.foot{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
{{BODY}}`;

module.exports = { render };
