'use strict';
// Page rendering: meters drawn to scale, escaping, sections, checks, empty states.
// Run: node lib/page.test.js
const assert = require('assert');
const page = require('./page');

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

const hit = (over) => Object.assign({
  ticker: 'KRRO', name: 'Korro Bio, Inc.', qualifiesBy: ['float 9.7M <= 50M'],
  metrics: { floatShares: 9.7e6, sharesOutstanding: 13.7e6, marketCap: 1.93e8, price: 14.06, shortPercentOfFloat: 14.4 },
  reaction: { regular: 10.5, extended: null },
  events: [{ tone: 'positive', type: 'regulatory / clinical', headline: 'Korro Receives Orphan Drug Designation', url: 'https://www.globenewswire.com/x',
    publisher: 'GlobeNewswire', at: '2026-11-24T12:00:00.000Z', tags: [] }],
  financials: null, dilution: null, followUp: null,
}, over || {});
const latest = (over) => Object.assign({
  generatedAt: '2026-11-24T21:08:00.000Z', date: '2026-11-24', run: 'pm',
  window: { from: '2026-11-24T05:00:00.000Z', to: '2026-11-24T21:07:00.000Z', basis: 'x' },
  criteria: { rule: 'float <= 50M', hit: 'a positive-type event', maxFloatShares: 50e6, maxMarketCap: 3e8, floatRouteMaxMarketCap: 2e9 },
  sources: { yahooSession: { ok: true }, sec: { enabled: false }, followUps: { days: 10 } },
  counts: { candidates: 140, qualified: 119, hits: 1, dilutionOrNegative: 0 },
  hits: [hit()], dilutionOrNegative: [], weakSignals: [],
}, over || {});

check('renders a hit: title first, event chip, link, ticker', () => {
  const html = page.render({ latest: latest(), history: { runs: [] } });
  assert.ok(html.indexOf('<title>Small-Float Scan</title>') === 0, 'title first');
  assert.ok(html.includes('class="chip positive">regulatory / clinical'));
  assert.ok(html.includes('href="https://www.globenewswire.com/x"'));
  assert.ok(html.includes('<h3>KRRO</h3>'));
});

check('meters are drawn to scale against the 50M and $300M lines', () => {
  const html = page.render({ latest: latest() });
  assert.ok(html.includes('class="fill" style="width:9.7%"'), 'float 9.7M on a 0-100M track');
  assert.ok(html.includes('class="fill" style="width:19.3%"'), 'cap $193M on a $0-1B track');
  assert.ok(html.includes('style="left:50.0%"><i>50M</i>'));
  assert.ok(html.includes('style="left:30.0%"><i>$300M</i>'));
});

check('a bar past its line turns grey exactly at the line; past the track it shows an overflow mark', () => {
  const big = hit({ ticker: 'GMRS', metrics: { floatShares: 42.1e6, marketCap: 7.293e8 } });
  const html = page.render({ latest: latest({ hits: [big] }) });
  assert.ok(html.includes('class="fill over" style="width:72.9%;--cut:41.1%"'), 'cut at 300/729.3');
  const huge = hit({ ticker: 'BIG', metrics: { floatShares: 150e6, marketCap: 2e8 } });
  const h2 = page.render({ latest: latest({ hits: [huge] }) });
  assert.ok(h2.includes('class="fill over" style="width:100.0%;--cut:50.0%"'));
  assert.ok(h2.includes('class="more"'));
});

check('third-party text is escaped and non-http links are dropped', () => {
  const evil = hit({ name: '<img src=x onerror=alert(1)>', events: [{ tone: 'positive', type: 'order / contract',
    headline: '"><script>alert(1)</script>', url: 'javascript:alert(1)', publisher: 'X', at: '2026-11-24T12:00:00Z', tags: [] }] });
  const history = { runs: [{ generatedAt: '2026-11-23T21:08:00.000Z', date: '2026-11-23', run: 'pm',
    hits: [{ ticker: 'OLDX', type: 'x', headline: 'old', url: 'javascript:alert(2)' }] }] };
  const html = page.render({ latest: latest({ hits: [evil] }), history: history });
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('javascript:'));
});

check('source checks print under the right hit', () => {
  const html = page.render({ latest: latest(), review: { items: [{ ticker: 'krro', verdict: 'confirmed', note: 'ODD confirmed in the 07:00 release' }] } });
  assert.ok(html.includes('class="check confirmed"'));
  assert.ok(html.includes('✓ Verified'));
  assert.ok(html.includes('ODD confirmed in the 07:00 release'));
});

check('earlier hits with new dilution get their own section', () => {
  const after = hit({ ticker: 'JZ', followUp: { hitAt: '2026-11-20T21:08:00Z', headline: 'JZ signs cooperation agreement' },
    events: [{ tone: 'dilution', type: 'offering', headline: 'JZ prices $4M offering', at: '2026-11-24T13:00:00Z', tags: [] }] });
  const html = page.render({ latest: latest({ dilutionOrNegative: [after], counts: { hits: 1, dilutionOrNegative: 1 } }) });
  assert.ok(html.includes('After the good news'));
  assert.ok(html.includes('JZ signs cooperation agreement'));
  assert.ok(html.includes('class="chip dilution">offering'));
});

check('hits from earlier runs stay on the page between runs', () => {
  const history = { runs: [
    { generatedAt: '2026-11-24T21:08:00.000Z', date: '2026-11-24', run: 'pm', hits: [] },
    { generatedAt: '2026-11-24T19:30:00.000Z', date: '2026-11-24', run: 'am', hits: [
      { ticker: 'GMRS', type: 'buyback / dividend', headline: 'GMR Solutions Authorizes $75 Million Share Buyback', url: 'https://example.com/g' },
      { ticker: 'KRRO', type: 'regulatory / clinical', headline: 'dup of a latest hit', url: 'https://example.com/k' } ] },
    { generatedAt: '2026-11-01T19:30:00.000Z', date: '2026-11-01', run: 'am', hits: [{ ticker: 'OLD', type: 'x', headline: 'too old' }] },
  ] };
  const html = page.render({ latest: latest(), history: history });
  assert.ok(html.includes('Earlier hits'));
  assert.ok(html.includes('GMR Solutions Authorizes $75 Million Share Buyback'));
  assert.ok(!html.includes('dup of a latest hit'), 'a ticker already in the latest hits is not repeated');
  assert.ok(!html.includes('too old'));
});

check('partial and degraded runs say so up top', () => {
  const html = page.render({ latest: latest({ sources: { yahooSession: { ok: false }, sec: { enabled: false }, coverage: { newsMissed: 12 } } }) });
  assert.ok(html.includes('Partial run.'));
  assert.ok(html.includes('Headlines for 12 qualifying names'));
  assert.ok(html.includes('unavailable'));
  assert.ok(html.includes('off — no contact set'));
});

check('SEC: a failed read says failed, not "no contact set"; a working one counts filings', () => {
  const failed = page.render({ latest: latest({ sources: { yahooSession: { ok: true }, sec: { enabled: true, ok: false, error: 'HTTP 403 from www.sec.gov' } } }) });
  assert.ok(failed.includes('failed — HTTP 403 from www.sec.gov'));
  assert.ok(!failed.includes('no contact set'));
  const on = page.render({ latest: latest({ sources: { yahooSession: { ok: true }, sec: { enabled: true, filings8K: 212, nonMoversAdded: 40 } } }) });
  assert.ok(on.includes('on · 212 8-Ks, 40 filers checked'));
});

check('empty states print plainly', () => {
  assert.ok(page.render({ latest: null }).includes('No run on file yet'));
  const html = page.render({ latest: latest({ hits: [], counts: { qualified: 87, hits: 0 } }), history: { runs: [] } });
  assert.ok(html.includes('No qualifying name had a positive-type event in this window.'));
  assert.ok(html.includes('No earlier runs on file.'));
});

console.log('\n' + pass + ' checks passed');
