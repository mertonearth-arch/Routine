'use strict';
// Page rendering: escaping, sections, review notes, empty states. Run: node lib/page.test.js
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
  criteria: { rule: 'float <= 50M', hit: 'a positive-type event' },
  sources: { yahooSession: { ok: true }, sec: { enabled: false }, followUps: { days: 10 } },
  counts: { candidates: 140, qualified: 119, hits: 1, dilutionOrNegative: 0 },
  hits: [hit()], dilutionOrNegative: [], weakSignals: [],
}, over || {});

check('renders a hit with its highlighter type, link and float', () => {
  const html = page.render({ latest: latest(), history: { runs: [] } });
  assert.ok(html.indexOf('<title>Small-Float Scan</title>') === 0, 'title first');
  assert.ok(html.includes('class="hl pos">REGULATORY / CLINICAL'));
  assert.ok(html.includes('href="https://www.globenewswire.com/x"'));
  assert.ok(html.includes('FLOAT <b>9.7M</b>'));
  assert.ok(html.includes('float 9.7M ≤ 50M'));
});

check('third-party text is escaped and non-http links are dropped', () => {
  const evil = hit({ name: '<img src=x onerror=alert(1)>', events: [{ tone: 'positive', type: 'order / contract',
    headline: '"><script>alert(1)</script>', url: 'javascript:alert(1)', publisher: 'X', at: '2026-11-24T12:00:00Z', tags: [] }] });
  const html = page.render({ latest: latest({ hits: [evil] }) });
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('javascript:'));
});

check('red-pen review notes land on the right record', () => {
  const html = page.render({ latest: latest(), review: { items: [{ ticker: 'krro', verdict: 'confirmed', note: 'ODD confirmed in the 07:00 release' }] } });
  assert.ok(html.includes('class="pen confirmed"'));
  assert.ok(html.includes('ODD confirmed in the 07:00 release'));
});

check('earlier hits with new dilution get their own section', () => {
  const after = hit({ ticker: 'JZ', followUp: { hitAt: '2026-11-20T21:08:00Z', headline: 'JZ signs cooperation agreement' },
    events: [{ tone: 'dilution', type: 'offering', headline: 'JZ prices $4M offering', at: '2026-11-24T13:00:00Z', tags: [] }] });
  const html = page.render({ latest: latest({ dilutionOrNegative: [after], counts: { hits: 1, dilutionOrNegative: 1 } }) });
  assert.ok(html.includes('After the good news'));
  assert.ok(html.includes('JZ signs cooperation agreement'));
});

check('empty states print plainly', () => {
  assert.ok(page.render({ latest: null }).includes('NO RUN ON FILE YET'));
  const html = page.render({ latest: latest({ hits: [], counts: { qualified: 87, hits: 0 } }), history: { runs: [] } });
  assert.ok(html.includes('NO QUALIFYING NAME HAD A POSITIVE-TYPE EVENT'));
  assert.ok(html.includes('NO EARLIER RUNS ON FILE'));
});

console.log('\n' + pass + ' checks passed');
