'use strict';
// View model: turns a scan report, the run history and the review notes into
// plain fields, so the page only decides how things look.
const F = require('./format');

function item(h, review, crit) {
  const m = h.metrics || {};
  const maxF = crit.maxFloatShares || 50e6;
  const maxC = crit.maxMarketCap || 300e6;
  const maxFR = crit.floatRouteMaxMarketCap || 2e9;
  const capOkForFloat = !F.isNum(m.marketCap) || m.marketCap <= maxFR;
  return {
    ticker: h.ticker, name: h.name || '', exchange: h.exchange || '',
    float: m.floatShares, so: m.sharesOutstanding, cap: m.marketCap, price: m.price, short: m.shortPercentOfFloat,
    move: h.reaction ? h.reaction.regular : m.changePct, ext: h.reaction ? h.reaction.extended : null,
    // Which rule qualified the stock (shares outstanding stands in only when float is unknown).
    q: {
      float: F.isNum(m.floatShares) && m.floatShares <= maxF && capOkForFloat,
      so: !F.isNum(m.floatShares) && F.isNum(m.sharesOutstanding) && m.sharesOutstanding <= maxF && capOkForFloat,
      cap: F.isNum(m.marketCap) && m.marketCap <= maxC,
    },
    events: (h.events || []).map((e) => ({
      type: e.type, tone: e.tone, headline: e.headline, url: F.safeUrl(e.url) ? e.url : null,
      publisher: e.publisher || e.sourceClass || '', when: F.et(e.at) || e.date || '',
      caveat: (e.tags || []).filter((t) => t.indexOf(e.type + ' (') === 0).map((t) => t.replace(/^.*\((.*)\)$/, '$1')).join(', '),
    })),
    fin: h.financials && h.financials.facts && h.financials.facts.length
      ? { period: h.financials.period, facts: h.financials.facts, stale: !!h.financials.stale, reasons: h.financials.reasons || [] } : null,
    dil: h.dilution && h.dilution.flagged ? h.dilution.filings : null,
    followUp: h.followUp || null,
    review: review || null,
  };
}

function model(input) {
  const r = input.latest;
  const history = input.history || { runs: [] };
  const crit = r.criteria || {};
  const reviews = {};
  ((input.review && input.review.items) || []).forEach((it) => { if (it && it.ticker) reviews[String(it.ticker).toUpperCase()] = it; });
  const s = r.sources || {};
  const c = r.counts || {};
  const negs = r.dilutionOrNegative || [];
  const days = (s.followUps && s.followUps.days) || 10;

  // Hits from earlier runs in the follow-up window, so the page is never blank
  // between runs; a ticker already in this run's hits is not repeated.
  const shown = new Set((r.hits || []).map((h) => h.ticker));
  const cutoff = Date.parse(r.generatedAt) - days * 86400000;
  const earlier = [];
  (history.runs || []).forEach((run) => {
    if (run.generatedAt === r.generatedAt || Date.parse(run.generatedAt) < cutoff) return;
    (run.hits || []).forEach((h) => { if (!shown.has(h.ticker)) { shown.add(h.ticker); earlier.push({ run: run, h: h }); } });
  });

  return {
    run: {
      date: r.date, dow: F.etDow(r.generatedAt), pass: String(r.run).toUpperCase(),
      printed: F.etTime(r.generatedAt), printedUtc: new Date(r.generatedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      from: F.et(r.window && r.window.from), to: F.etTime(r.window && r.window.to),
      checked: c.candidates || 0, qualified: c.qualified || 0, hits: (r.hits || []).length, negs: negs.length,
      yahooOk: !!(s.yahooSession && s.yahooSession.ok),
      // SEC: off (no contact set), failed (set, but EDGAR could not be read) or on.
      secState: !(s.sec && s.sec.enabled) ? 'off' : (s.sec.ok === false ? 'failed' : 'on'),
      secError: (s.sec && s.sec.error) || '', secFilings: (s.sec && s.sec.filings8K) || 0, secAdded: (s.sec && s.sec.nonMoversAdded) || 0,
      partial: s.coverage && s.coverage.newsMissed ? s.coverage.newsMissed : 0, days: days,
    },
    criteria: { rule: String(crit.rule || '').replace(/<=/g, '≤'), hit: String(crit.hit || '').replace(/<=/g, '≤'),
      maxFloat: crit.maxFloatShares || 50e6, maxCap: crit.maxMarketCap || 300e6 },
    hits: (r.hits || []).map((h) => item(h, reviews[h.ticker], crit)),
    after: negs.filter((h) => h.followUp).map((h) => item(h, reviews[h.ticker], crit)),
    negs: negs.filter((h) => !h.followUp).map((h) => item(h, reviews[h.ticker], crit)),
    weak: (r.weakSignals || []).map((h) => item(h, null, crit)),
    earlier: earlier,
    log: (history.runs || []).slice(0, 24),
  };
}

module.exports = { model, item };
