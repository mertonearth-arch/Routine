'use strict';
// Run history: what each scan found, kept compact so it can ride along with the
// published page (data/history.json) instead of living in git. Every scheduled
// run downloads it, scans from where the last run stopped, appends itself and
// publishes it back. The repo stays code-only and the runs never need to push.

const VERSION = 1;
const MAX_RUNS = 80; // ~40 trading days of AM + PM runs

function empty() {
  return { version: VERSION, runs: [] };
}

function parse(text) {
  try {
    const h = JSON.parse(text);
    if (h && Array.isArray(h.runs)) return { version: h.version || VERSION, runs: h.runs };
  } catch (e) { /* unreadable history: start over rather than fail the run */ }
  return empty();
}

const newest = (h) => (h.runs || []).slice().sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)))[0] || null;

// Scan window: from the last published run (minus a small overlap) to now,
// capped so a long gap — a weekend, a failed run — doesn't become a week of news.
function scanWindow(h, opts) {
  const now = opts.now === undefined ? Date.now() : opts.now;
  const cap = now - opts.capHours * 3600000;
  const to = new Date(now).toISOString();
  if (opts.since) {
    return { from: new Date(Math.max(Date.parse(opts.since), cap)).toISOString(), to: to, basis: '--since' };
  }
  const last = newest(h);
  if (last && last.generatedAt) {
    const from = Math.max(Date.parse(last.generatedAt) - opts.overlapMinutes * 60000, cap);
    return { from: new Date(from).toISOString(), to: to, basis: 'since the ' + last.date + ' ' + String(last.run).toUpperCase() + ' run' };
  }
  return { from: new Date(now - opts.defaultHours * 3600000).toISOString(), to: to, basis: 'first run: last ' + opts.defaultHours + 'h' };
}

// Tickers that hit within the last `days`, newest hit first. They are re-checked
// on later runs, because the follow-up to a small cap's good news is so often an
// offering, and that is worth seeing next to the original headline.
// Hits inside the follow-up window, one entry per ticker (newest hit first),
// carrying every story told about it in that window and any financial hits,
// so a later run can tell a re-report from new news.
function recentHits(h, days, now) {
  now = now === undefined ? Date.now() : now;
  const cutoff = now - days * 86400000;
  const seen = new Map();
  (h.runs || []).slice().sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt))).forEach((run) => {
    if (Date.parse(run.generatedAt) < cutoff) return;
    (run.hits || []).forEach((hit) => {
      if (!seen.has(hit.ticker)) {
        seen.set(hit.ticker, { ticker: hit.ticker, name: hit.name, hitAt: run.generatedAt, type: hit.type, headline: hit.headline, url: hit.url,
          stories: [], financialHits: [] });
      }
      const e = seen.get(hit.ticker);
      const told = hit.stories && hit.stories.length ? hit.stories : (hit.headline ? [{ headline: hit.headline, url: hit.url || null }] : []);
      told.forEach((st) => {
        const key = String(st.headline || '').toLowerCase();
        if (key && e.stories.length < 12 && !e.stories.some((x) => String(x.headline).toLowerCase() === key)) e.stories.push({ headline: st.headline, url: st.url || null });
      });
      if (hit.financials) e.financialHits.push({ period: hit.financialsPeriod || null, hitAt: run.generatedAt });
    });
  });
  return Array.from(seen.values());
}

const pick = (e) => (e ? { type: e.type, headline: e.headline, url: e.url || null, publisher: e.publisher || null, at: e.at || e.date || null } : {});

function compactRun(report) {
  const firstPositive = (h) => (h.events || []).find((e) => e.tone === 'positive') || (h.events || [])[0];
  const firstNegative = (h) => (h.events || []).find((e) => e.tone === 'dilution' || e.tone === 'negative');
  return {
    generatedAt: report.generatedAt,
    date: report.date,
    run: report.run,
    window: report.window,
    counts: report.counts,
    sources: {
      yahoo: !!(report.sources && report.sources.yahooSession && report.sources.yahooSession.ok),
      sec: !!(report.sources && report.sources.sec && report.sources.sec.enabled && report.sources.sec.ok !== false),
    },
    hits: (report.hits || []).map((h) => Object.assign({
      ticker: h.ticker, name: h.name,
      floatShares: h.metrics.floatShares, sharesOutstanding: h.metrics.sharesOutstanding, marketCap: h.metrics.marketCap,
      changePct: h.metrics.changePct, dilution: !!(h.dilution && h.dilution.flagged),
      financials: h.financials && h.financials.qualifies ? h.financials.reasons : null,
      financialsPeriod: h.financials && h.financials.qualifies ? h.financials.period || null : null,
      // Up to three of the hit's positive stories, so later runs know them when retold.
      stories: (h.events || []).filter((e) => e.tone === 'positive').slice(0, 3).map((e) => ({ headline: e.headline, url: e.url || null })),
    }, pick(firstPositive(h)))),
    negatives: (report.dilutionOrNegative || []).map((h) => Object.assign({ ticker: h.ticker, name: h.name }, pick(firstNegative(h)))),
  };
}

// Add this run; a re-run of the same date + AM/PM replaces the earlier entry.
function appendRun(h, report) {
  const run = compactRun(report);
  const runs = (h.runs || []).filter((r) => !(r.date === run.date && r.run === run.run));
  runs.push(run);
  runs.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
  return { version: VERSION, updated: run.generatedAt, runs: runs.slice(0, MAX_RUNS) };
}

module.exports = { VERSION, MAX_RUNS, empty, parse, newest, scanWindow, recentHits, compactRun, appendRun };
