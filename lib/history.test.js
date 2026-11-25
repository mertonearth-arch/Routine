'use strict';
// Run history: window continuity, follow-ups, trimming. Run: node lib/history.test.js
const assert = require('assert');
const H = require('./history');

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const opts = { capHours: 72, overlapMinutes: 30, defaultHours: 24 };
const report = (date, run, generatedAt, hits, negs) => ({
  generatedAt: generatedAt, date: date, run: run, window: { from: 'x', to: generatedAt },
  counts: { hits: hits.length, dilutionOrNegative: (negs || []).length },
  sources: { yahooSession: { ok: true }, sec: { enabled: false } },
  hits: hits.map((t) => ({ ticker: t, name: t + ' Inc', metrics: { floatShares: 1e6, marketCap: 2e7 },
    events: [{ tone: 'positive', type: 'order / contract', headline: t + ' wins order', url: 'https://example.com/' + t, at: generatedAt }] })),
  dilutionOrNegative: (negs || []).map((t) => ({ ticker: t, name: t, metrics: {},
    events: [{ tone: 'dilution', type: 'offering', headline: t + ' prices offering', at: generatedAt }] })),
});

check('first run looks back the default 24h', () => {
  const now = Date.parse('2026-11-24T21:07:00Z');
  const w = H.scanWindow(H.empty(), Object.assign({ now: now }, opts));
  assert.strictEqual(w.from, '2026-11-23T21:07:00.000Z');
  assert.ok(/first run/.test(w.basis));
});

check('later runs continue from the last published run, minus the overlap', () => {
  let h = H.appendRun(H.empty(), report('2026-11-24', 'am', '2026-11-24T05:28:00.000Z', ['ABCD']));
  const w = H.scanWindow(h, Object.assign({ now: Date.parse('2026-11-24T21:07:00Z') }, opts));
  assert.strictEqual(w.from, '2026-11-24T04:58:00.000Z');
});

check('a long gap is capped at 72h (Monday AM after a dead weekend)', () => {
  const h = H.appendRun(H.empty(), report('2026-11-13', 'pm', '2026-11-13T21:08:00.000Z', []));
  const now = Date.parse('2026-11-24T05:27:00Z');
  const w = H.scanWindow(h, Object.assign({ now: now }, opts));
  assert.strictEqual(w.from, new Date(now - 72 * 3600000).toISOString());
});

check('--since wins over history', () => {
  const h = H.appendRun(H.empty(), report('2026-11-24', 'am', '2026-11-24T05:28:00.000Z', []));
  const w = H.scanWindow(h, Object.assign({ now: Date.parse('2026-11-24T21:07:00Z'), since: '2026-11-24T12:00:00Z' }, opts));
  assert.strictEqual(w.from, '2026-11-24T12:00:00.000Z');
});

check('re-running the same date + pass replaces it instead of duplicating', () => {
  let h = H.appendRun(H.empty(), report('2026-11-24', 'pm', '2026-11-24T21:08:00.000Z', ['AAA']));
  h = H.appendRun(h, report('2026-11-24', 'pm', '2026-11-24T21:20:00.000Z', ['BBB']));
  assert.strictEqual(h.runs.length, 1);
  assert.strictEqual(h.runs[0].hits[0].ticker, 'BBB');
});

check('history keeps the newest MAX_RUNS, newest first', () => {
  let h = H.empty();
  for (let i = 0; i < H.MAX_RUNS + 5; i++) {
    const t = new Date(Date.parse('2026-01-01T00:00:00Z') + i * 43200000).toISOString();
    h = H.appendRun(h, report(t.slice(0, 10), i % 2 ? 'pm' : 'am', t, []));
  }
  assert.strictEqual(h.runs.length, H.MAX_RUNS);
  assert.ok(h.runs[0].generatedAt > h.runs[1].generatedAt);
});

check('recent hits feed the follow-up check; older ones drop off', () => {
  let h = H.appendRun(H.empty(), report('2026-11-10', 'am', '2026-11-10T05:28:00.000Z', ['OLD']));
  h = H.appendRun(h, report('2026-11-20', 'pm', '2026-11-20T21:08:00.000Z', ['NEW']));
  const r = H.recentHits(h, 10, Date.parse('2026-11-24T21:07:00Z'));
  assert.deepStrictEqual(r.map((x) => x.ticker), ['NEW']);
  assert.strictEqual(r[0].headline, 'NEW wins order');
});

check('compact run keeps the headline, link and the first dilution item', () => {
  const c = H.compactRun(report('2026-11-24', 'am', '2026-11-24T05:28:00.000Z', ['KRRO'], ['QUCY']));
  assert.strictEqual(c.hits[0].url, 'https://example.com/KRRO');
  assert.strictEqual(c.negatives[0].type, 'offering');
  assert.strictEqual(c.sources.yahoo, true);
  assert.strictEqual(c.sources.sec, false);
});

check('a hit keeps up to three stories and its financial period; follow-ups gather every story told', () => {
  const am = report('2026-11-24', 'am', '2026-11-24T05:28:00.000Z', ['KRRO']);
  am.hits[0].events = [
    { tone: 'positive', type: 'regulatory / clinical', headline: 'Korro Bio Says FDA Orphan Drug Designation Granted to KRRO-121', url: 'https://example.com/a' },
    { tone: 'positive', type: 'regulatory / clinical', headline: 'Korro receives ODD for KRRO-121', url: 'https://example.com/b' },
    { tone: 'neutral', type: 'filing', headline: '8-K: 7.01 Reg FD disclosure' }];
  am.hits[0].financials = { qualifies: true, period: '2026-09-30', reasons: ['x'] };
  let h = H.appendRun(H.empty(), am);
  assert.deepStrictEqual(h.runs[0].hits[0].stories.map((s) => s.url), ['https://example.com/a', 'https://example.com/b']);
  assert.strictEqual(h.runs[0].hits[0].financialsPeriod, '2026-09-30');
  h = H.appendRun(h, report('2026-11-24', 'pm', '2026-11-24T21:08:00.000Z', ['KRRO']));
  // An entry written before stories were kept still counts its headline.
  h.runs.push({ generatedAt: '2026-11-23T21:08:00.000Z', date: '2026-11-23', run: 'pm', hits: [{ ticker: 'KRRO', headline: 'old style', financials: ['y'] }] });
  const r = H.recentHits(h, 10, Date.parse('2026-11-25T05:27:00Z'));
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].headline, 'KRRO wins order', 'the newest hit leads');
  assert.deepStrictEqual(r[0].stories.map((s) => s.headline),
    ['KRRO wins order', 'Korro Bio Says FDA Orphan Drug Designation Granted to KRRO-121', 'Korro receives ODD for KRRO-121', 'old style']);
  assert.deepStrictEqual(r[0].financialHits.map((x) => x.period), ['2026-09-30', null]);
});

check('unreadable history starts over instead of failing the run', () => {
  assert.deepStrictEqual(H.parse('{not json').runs, []);
  assert.deepStrictEqual(H.parse('').runs, []);
});

console.log('\n' + pass + ' checks passed');
