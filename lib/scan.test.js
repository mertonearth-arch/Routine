'use strict';
// Small-float scanner logic. Run: node lib/scan.test.js
// Headlines below are real shapes seen on the wires, several verbatim from the
// first live scan (2026-11-24).
const assert = require('assert');
const L = require('./scan');
const SEC = require('./sec');

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const cls = (h) => L.classify(h);

// --- classification -----------------------------------------------------------------
const cases = [
  ['Korro Receives Orphan Drug Designation for KRRO-121 From U.S. FDA for the Treatment of Urea Cycle Disorders', 'positive', 'regulatory / clinical'],
  ['GMR Solutions Inc. Announces $75 Million Share Repurchase Authorization', 'positive', 'buyback / dividend'],
  ['Fossil Group Announces Extension of Michael Kors Global Watch Partnership Through 2032', 'positive', 'renewal / extension'],
  ['ABCD Secures $12.5 Million Purchase Order From Tier-1 Defense Prime', 'positive', 'order / contract'],
  ['ABCD Awarded $4.2 Million Contract by U.S. Army', 'positive', 'order / contract'],
  ['ABCD Reports Record Third Quarter Revenue of $14.1 Million, Up 85% Year-Over-Year', 'positive', 'earnings'],
  ['ABCD Raises Full-Year 2026 Revenue Guidance', 'positive', 'earnings'],
  ['ABCD Enters into Definitive Agreement to be Acquired by XYZ for $4.10 Per Share in Cash', 'positive', 'M&A (target)'],
  ['ABCD Regains Compliance with Nasdaq Minimum Bid Price Requirement', 'positive', 'listing / index'],
  ['ABCD Announces Pricing of $5 Million Registered Direct Offering Priced At-the-Market Under Nasdaq Rules', 'dilution', 'offering'],
  ['ABCD Announces Closing of $8.0 Million Public Offering', 'dilution', 'offering'],
  ['ABCD Enters into $20 Million Equity Purchase Agreement', 'dilution', 'equity line / ATM'],
  ['ABCD Announces Warrant Inducement Transaction for Gross Proceeds of $3.1 Million', 'dilution', 'warrants / convertibles'],
  // Ending an ATM removes an overhang: the first live scan had this backwards.
  ['Quantum Cyber to Terminate $100 Million At-the-Market Facility With No Shares Sold', 'positive', 'dilution withdrawn'],
  ['ABCD Announces 1-for-20 Reverse Stock Split', 'negative', 'reverse split'],
  ['ABCD Receives Shareholder Approval for Reverse Stock Split', 'negative', 'reverse split'],
  ['TURBO ENERGY RECEIVES NASDAQ NOTIFICATION REGARDING MINIMUM BID PRICE DEFICIENCY', 'negative', 'listing notice'],
  ['ABCD Receives Complete Response Letter from FDA', 'negative', 'clinical / regulatory setback'],
  ['ABCD Phase 2 Trial Did Not Meet Primary Endpoint', 'negative', 'clinical / regulatory setback'],
  ['BIO-key International Inc. (BKYI) Reports Q3 Loss, Lags Revenue Estimates', 'negative', 'earnings'],
  ['Compass Minerals Fiscal Q4 Adjusted Loss Widens, Revenue Rises', 'mixed', 'earnings'],
  ['Compass Minerals Reports Fiscal Fourth-Quarter and Full-Year 2026 Results', 'neutral', 'earnings'],
  ['ABCD Reports Third Quarter 2026 Results and Will Host Conference Call on November 14', 'neutral', 'earnings'],
  ['ABCD to Report Third Quarter 2026 Financial Results on November 13', 'noise', 'scheduling / IR'],
  ['ABCD Selected to Present at the LD Micro Main Event', 'noise', 'scheduling / IR'],
  ['ABCD Signs Definitive Merger Agreement with XYZ', 'neutral', 'M&A (acquirer)'],
  ['INVESTOR ALERT: Pomerantz Law Firm Investigates Claims On Behalf of Investors of ABCD', 'noise', 'law-firm notice'],
  ['NeOnc Announces FDA Agreement on Single Study Design and Accelerated Approval Pathway', 'positive', 'regulatory / clinical'],
  ['Jianzhi Education Signs Non-Binding Comprehensive Cross-Border E-Commerce Cooperation Agreement', 'positive', 'partnership'],
  ['FF EAI Robotics Ecosystem (FFR) Announces K-12 Robotics Education Partnerships', 'positive', 'partnership'],
  ['CAPR Stock Clocks Worst Day Ever After FDA Rejects Approval For DMD Therapy', 'negative', 'clinical / regulatory setback'],
  ['Elmet Group Insider Sold Shares Worth $1,100,434, According to a Recent SEC Filing', 'negative', 'insider selling'],
  ['UBS Upgrades Ares Commercial Real Estate to Buy From Neutral, $4.50 Price Target', 'positive', 'analyst action'],
  ['Tronox Holdings (TROX) Stock Fair Value Moves Lower After Analyst Target Cuts', 'negative', 'analyst action'],
  // A finished business-segment wind-down is not the company folding (seen live 2026-11-24).
  ['Alico Inc (ALCO) (Q4 2026) Earnings Call Highlights: Citrus Wind-Down Complete as Land Strategy Advances', 'neutral', 'other'],
  ['ABCD Announces Plan to Wind Down Operations and Seek Strategic Alternatives', 'negative', 'going concern / bankruptcy'],
];
cases.forEach(([h, tone, type]) => {
  check('classify: ' + h.slice(0, 64), () => {
    const c = cls(h);
    assert.strictEqual(c.tone, tone, 'tone for "' + h + '" was ' + c.tone + ' (' + c.type + ')');
    assert.strictEqual(c.type, type, 'type for "' + h + '" was ' + c.type);
  });
});

check('dilution beats a positive word in the same headline', () => {
  assert.strictEqual(cls('ABCD Announces $15M Registered Direct Offering to Fund Pivotal Trial After FDA Fast Track Designation').tone, 'dilution');
});

// --- who said it ---------------------------------------------------------------------
check('source classes', () => {
  assert.strictEqual(L.sourceClass('GlobeNewswire'), 'company release');
  assert.strictEqual(L.sourceClass('ACCESS Newswire'), 'company release');
  assert.strictEqual(L.sourceClass('Motley Fool'), 'commentary');
  assert.strictEqual(L.sourceClass('MT Newswires'), 'media');
});

check('a story counts only if its headline names the company', () => {
  assert.strictEqual(L.aboutCompany('Best Buy Q3 Earnings Beat Estimates on Broad-Based Sales Growth', 'FOSL', 'Fossil Group, Inc.'), false);
  assert.strictEqual(L.aboutCompany('Fossil Extends Michael Kors Watch Partnership Through 2032', 'FOSL', 'Fossil Group, Inc.'), true);
  assert.strictEqual(L.aboutCompany('Korro Receives Orphan Drug Designation for KRRO-121', 'KRRO', 'Korro Bio, Inc.'), true);
  assert.strictEqual(L.aboutCompany('Compass Minerals (CMP) Reports Q4 Loss', 'CMP', 'Compass Minerals International, Inc.'), true);
  assert.strictEqual(L.aboutCompany('Dragonfly Energy (DFLI) Reports Q3 Loss', 'BKYI', 'BIO-key International, Inc.'), false);
  // two-letter tickers never match on the symbol alone ("AI", "GO" are words)
  assert.strictEqual(L.aboutCompany('How AI Is Changing Retail', 'AI', 'C3.ai, Inc.'), false);
});

// --- listing filter + qualification ----------------------------------------------------------
check('common stock only: warrants, units, rights, preferreds and OTC are out', () => {
  assert.strictEqual(L.isCommonListing('KRRO', 'NCM'), true);
  assert.strictEqual(L.isCommonListing('BSLKW', 'NGM'), false);
  assert.strictEqual(L.isCommonListing('ABCDU', 'NCM'), false);
  assert.strictEqual(L.isCommonListing('ABCDR', 'NCM'), false);
  assert.strictEqual(L.isCommonListing('COF-PL', 'NYQ'), false);
  assert.strictEqual(L.isCommonListing('MCCHF', 'PNK'), false);
  assert.strictEqual(L.isCommonListing('BRK-B', 'NYQ'), true);
});

check('qualify: float route, shares-outstanding bound, cap route', () => {
  const cfg = L.config();
  assert.deepStrictEqual(L.qualify({ floatShares: 9.7e6, sharesOutstanding: 13.7e6, marketCap: 200e6 }, cfg).by.length, 2);
  // float unknown, but shares outstanding <= 50M bounds it
  const so = L.qualify({ floatShares: null, sharesOutstanding: 30e6, marketCap: 900e6 }, cfg);
  assert.strictEqual(so.ok, true);
  assert.ok(/float can only be lower/.test(so.by[0]));
  // float known and above the line: shares outstanding is not used instead
  assert.strictEqual(L.qualify({ floatShares: 80e6, sharesOutstanding: 40e6, marketCap: 900e6 }, cfg).ok, false);
  // tiny cap qualifies whatever the share count
  assert.strictEqual(L.qualify({ floatShares: 400e6, sharesOutstanding: 500e6, marketCap: 90e6 }, cfg).ok, true);
});

check('qualify: a big company with few shares is not a low-float name (NVR, FICO)', () => {
  const q = L.qualify({ floatShares: 2.9e6, sharesOutstanding: 3e6, marketCap: 22e9 }, L.config());
  assert.strictEqual(q.ok, false);
  assert.ok(/not a low-float name/.test(q.excluded));
});

// --- financials -------------------------------------------------------------------------------
const finBKYI = {
  TotalRevenue: [{ asOfDate: '2025-09-30', value: 1549706 }, { asOfDate: '2026-06-30', value: 1919991 }, { asOfDate: '2026-09-30', value: 1482781 }],
  NetIncome: [{ asOfDate: '2025-09-30', value: -964849 }, { asOfDate: '2026-09-30', value: -886083 }],
  OrdinarySharesNumber: [{ asOfDate: '2025-09-30', value: 731342 }, { asOfDate: '2026-09-30', value: 2035149 }],
  CashAndCashEquivalents: [{ asOfDate: '2026-09-30', value: 2219428 }],
};
check('financial deltas: BKYI Q3 2026 — revenue down, loss barely narrower, share count nearly tripled', () => {
  const f = L.financialDeltas(finBKYI, '2026-11-13', L.config());
  assert.strictEqual(f.revenueYoY, -4.3);
  assert.strictEqual(f.lossNarrowedPct, 8.2);
  assert.strictEqual(f.sharesYoY, 178.3);
  assert.strictEqual(f.qualifies, false);
  assert.strictEqual(f.stale, false);
});

check('financial deltas: growth and a turn to profit qualify; a lagging quarter is stale', () => {
  const fin = {
    TotalRevenue: [{ asOfDate: '2025-06-30', value: 10e6 }, { asOfDate: '2026-06-30', value: 14e6 }],
    NetIncome: [{ asOfDate: '2025-06-30', value: -1e6 }, { asOfDate: '2026-06-30', value: 0.5e6 }],
  };
  const fresh = L.financialDeltas(fin, '2026-08-10', L.config());
  assert.strictEqual(fresh.qualifies, true);
  assert.deepStrictEqual(fresh.reasons, ['revenue +40% YoY', 'net income turned positive']);
  // Released 2026-11-23 but Yahoo still shows the June quarter: describes the previous report.
  const stale = L.financialDeltas(fin, '2026-11-23', L.config());
  assert.strictEqual(stale.stale, true);
  assert.strictEqual(stale.qualifies, false);
});

// --- decision -----------------------------------------------------------------------------------
check('decide: an analyst upgrade or a launch alone is a weak signal, not a hit', () => {
  const up = L.decide({ events: [{ tone: 'positive', type: 'analyst action', sourceClass: 'media', headline: 'UBS upgrades' }] });
  assert.strictEqual(up.hit, false);
  assert.strictEqual(up.weakOnly, true);
  const both = L.decide({ events: [{ tone: 'positive', type: 'analyst action', sourceClass: 'media', headline: 'a' },
    { tone: 'positive', type: 'order / contract', sourceClass: 'company release', headline: 'b' }] });
  assert.strictEqual(both.hit, true);
});

check('the same headline from several outlets is kept once, company release first', () => {
  const ev = [
    { headline: 'NeOnc Announces FDA Agreement on Single Study Design', sourceClass: 'media', publisher: 'Stocktwits', at: '2026-11-24T14:11:00Z' },
    { headline: 'NeOnc Announces FDA Agreement on Single Study Design', sourceClass: 'company release', publisher: 'GlobeNewswire', at: '2026-11-24T13:00:00Z' },
    { headline: 'NeOnc to Present at Conference', sourceClass: 'company release', publisher: 'GlobeNewswire', at: '2026-11-24T12:00:00Z' },
  ];
  const d = L.dedupeEvents(ev);
  assert.strictEqual(d.length, 2);
  assert.strictEqual(d[0].publisher, 'GlobeNewswire');
});

check('decide: commentary is not a source for bad news either', () => {
  const d = L.decide({ events: [{ tone: 'negative', type: 'insider selling', sourceClass: 'commentary', headline: 'x' }] });
  assert.strictEqual(d.negatives.length, 0);
});

check('decide: commentary alone never makes a hit; a contested print does not either', () => {
  const ev = (tone, type, sourceClass) => ({ tone: tone, type: type, sourceClass: sourceClass, headline: type });
  assert.strictEqual(L.decide({ events: [ev('positive', 'order / contract', 'commentary')] }).hit, false);
  assert.strictEqual(L.decide({ events: [ev('positive', 'order / contract', 'company release')] }).hit, true);
  const contested = L.decide({ events: [ev('positive', 'earnings', 'media'), ev('mixed', 'earnings', 'media')] });
  assert.strictEqual(contested.hit, false);
  assert.strictEqual(contested.contested, true);
});

// --- SEC ----------------------------------------------------------------------------------------
const ATOM = '<?xml version="1.0" encoding="ISO-8859-1" ?><feed xmlns="http://www.w3.org/2005/Atom">' +
  '<entry><title>8-K - BIO-key International Inc (0001019034) (Filer)</title>' +
  '<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1019034/000143774926036667/0001437749-26-036667-index.htm"/>' +
  '<summary type="html"> &lt;b&gt;Filed:&lt;/b&gt; 2026-11-13 &lt;b&gt;AccNo:&lt;/b&gt; 0001437749-26-036667 &lt;b&gt;Size:&lt;/b&gt; 1 MB' +
  '&lt;br&gt;Item 2.02: Results of Operations and Financial Condition&lt;br&gt;Item 9.01: Financial Statements and Exhibits</summary>' +
  '<updated>2026-11-13T08:00:12-05:00</updated><category scheme="https://www.sec.gov/" label="form type" term="8-K"/>' +
  '<id>urn:tag:sec.gov,2008:accession-number=0001437749-26-036667</id></entry></feed>';
check('SEC current-events feed parses form, company, CIK, items, accession', () => {
  const e = SEC.parseCurrentFeed(ATOM)[0];
  assert.strictEqual(e.form, '8-K');
  assert.strictEqual(e.company, 'BIO-key International Inc');
  assert.strictEqual(e.cik, 1019034);
  assert.strictEqual(e.role, 'Filer');
  assert.deepStrictEqual(e.items, ['2.02', '9.01']);
  assert.strictEqual(e.accession, '0001437749-26-036667');
  assert.strictEqual(e.at, '2026-11-13T13:00:12.000Z');
});

check('SEC feed: a time without an offset is New York time; the accession falls back to the entry id', () => {
  const xml = ATOM.replace('-05:00</updated>', '</updated>').replace('&lt;b&gt;AccNo:&lt;/b&gt; 0001437749-26-036667', '');
  const e = SEC.parseCurrentFeed(xml)[0];
  assert.strictEqual(e.at, '2026-11-13T13:00:12.000Z');
  assert.strictEqual(e.accession, '0001437749-26-036667');
});

check('EDGAR times: the 8-K feed time wins; a bare "Z" time is read both ways inside EDGAR hours', () => {
  const iso = (a) => a.map((t) => new Date(t).toISOString());
  assert.deepStrictEqual(iso(L.edgarTimes({ feedTime: '2026-11-24T22:00:12.000Z', acceptance: '2026-11-24T17:00:12.000Z' })), ['2026-11-24T22:00:12.000Z']);
  // 08:00 read as UTC is 03:00 New York, when EDGAR is closed: so it is New York time.
  assert.deepStrictEqual(iso(L.edgarTimes({ acceptance: '2026-11-24T08:00:00.000Z' })), ['2026-11-24T13:00:00.000Z']);
  // 23:30 read as New York time is after EDGAR closes: so it is UTC.
  assert.deepStrictEqual(iso(L.edgarTimes({ acceptance: '2026-11-24T23:30:00.000Z' })), ['2026-11-24T23:30:00.000Z']);
  // 17:00 could be noon or 17:00 New York: both readings stay.
  assert.deepStrictEqual(iso(L.edgarTimes({ acceptance: '2026-11-24T17:00:00.000Z' })), ['2026-11-24T17:00:00.000Z', '2026-11-24T22:00:00.000Z']);
  assert.deepStrictEqual(iso(L.edgarTimes({ acceptance: '2026-07-01T17:00:00-04:00' })), ['2026-07-01T21:00:00.000Z']);
});

check('SEC events: an after-close 8-K is not lost to a mislabelled clock; an unsettled time prints as a date', () => {
  const am = { from: '2026-11-24T20:37:00.000Z', to: '2026-11-25T05:27:00.000Z' }; // AM run: 15:37 to 00:27 New York
  const late = { form: '8-K', filingDate: '2026-11-24', acceptance: '2026-11-24T17:00:00.000Z', items: ['1.01', '9.01'], url: 'u' };
  const ev = L.secEvents([late], am);
  assert.strictEqual(ev.length, 1, 'read only as UTC (noon New York) it fell outside the window');
  assert.strictEqual(ev[0].at, null);
  assert.strictEqual(ev[0].date, '2026-11-24');
  assert.strictEqual(L.secEvents([Object.assign({}, late, { feedTime: '2026-11-24T22:00:00.000Z' })], am)[0].at, '2026-11-24T22:00:00.000Z');
  assert.strictEqual(L.secEvents([Object.assign({}, late, { acceptance: '2026-11-24T08:00:00.000Z' })], am).length, 0, '08:00 New York is before this window');
});

check('8-K items: 1.01 + 3.02 reads as a placement; 2.02 is an earnings filing', () => {
  assert.strictEqual(L.describe8K(['1.01', '3.02', '9.01']).tone, 'dilution');
  assert.strictEqual(L.describe8K(['2.02', '9.01']).earnings, true);
  assert.strictEqual(L.describe8K(['3.01']).tone, 'negative');
});

check('dilution check: shelf, prospectus and 3.02 inside 90 days, nothing older', () => {
  const filings = [
    { form: '424B5', filingDate: '2026-11-01', items: [], url: 'u1' },
    { form: 'S-3', filingDate: '2026-09-20', items: [], url: 'u2' },
    { form: '8-K', filingDate: '2026-10-15', items: ['1.01', '3.02'], url: 'u3' },
    { form: 'S-1', filingDate: '2026-03-01', items: [], url: 'u4' },
    { form: '10-Q', filingDate: '2026-11-10', items: [], url: 'u5' },
  ];
  const d = L.dilutionCheck(filings, '2026-11-24', L.config());
  assert.strictEqual(d.flagged, true);
  assert.deepStrictEqual(d.filings.map((f) => f.form), ['424B5', 'S-3', '8-K']);
});

check('submissions JSON flattens with item lists and document URLs', () => {
  const rows = SEC.flattenRecent({ filings: { recent: {
    accessionNumber: ['0001437749-26-036667'], filingDate: ['2026-11-13'], acceptanceDateTime: ['2026-11-13T08:00:12.000Z'],
    form: ['8-K'], items: ['2.02,9.01'], primaryDocument: ['bkyi20261113_8k.htm'], primaryDocDescription: ['8-K'],
  } } }, 1019034);
  assert.deepStrictEqual(rows[0].items, ['2.02', '9.01']);
  assert.strictEqual(rows[0].url, 'https://www.sec.gov/Archives/edgar/data/1019034/000143774926036667/bkyi20261113_8k.htm');
  assert.strictEqual(rows[0].accession, '0001437749-26-036667');
});

check('SEC stays off without a declared contact', () => {
  const before = process.env.SEC_USER_AGENT;
  delete process.env.SEC_USER_AGENT;
  assert.strictEqual(SEC.enabled(), false);
  process.env.SEC_USER_AGENT = 'CadenceDesk research';          // no contact address
  assert.strictEqual(SEC.enabled(), false);
  if (before === undefined) delete process.env.SEC_USER_AGENT; else process.env.SEC_USER_AGENT = before;
});

check('SEC_USER_AGENT may be just the contact address; the scanner adds its own name', () => {
  const before = process.env.SEC_USER_AGENT;
  process.env.SEC_USER_AGENT = 'ops@example.com';
  assert.strictEqual(SEC.enabled(), true);
  assert.strictEqual(SEC.ua(), 'RoutineScanner ops@example.com');
  process.env.SEC_USER_AGENT = 'Acme Research ops@example.com';
  assert.strictEqual(SEC.ua(), 'Acme Research ops@example.com');
  if (before === undefined) delete process.env.SEC_USER_AGENT; else process.env.SEC_USER_AGENT = before;
});

// --- which names are checked -------------------------------------------------------------------
const names = (p, n) => Array.from({ length: n }, (_, i) => p + i);
check('candidates: a busy filing day cannot push the movers out, nor a busy tape the filings', () => {
  const earlier = ['KRRO', 'GMRS', 'QUCY', 'CLIK'];
  const p = L.pickCandidates(earlier, names('M', 256).concat(['KRRO']), names('F', 220), L.config());
  const all = p.earlier.concat(p.movers, p.filers);
  assert.strictEqual(all.length, 150);
  assert.strictEqual(new Set(all).size, 150, 'no name twice');
  assert.deepStrictEqual(p.earlier, earlier);
  assert.strictEqual(p.movers.length, 106, '150 - 4 earlier hits - 40 held for filers');
  assert.strictEqual(p.movers[0], 'M0', 'biggest movers first');
  assert.deepStrictEqual(p.filers, names('F', 40), 'filers in rank order');
});

check('candidates: unused slots go to the other side; a filer just below the movers cut still gets in', () => {
  const cfg = L.config();
  const few = L.pickCandidates([], ['M1', 'M2'], names('F', 300), cfg);
  assert.deepStrictEqual([few.movers.length, few.filers.length], [2, 148]);
  const noSec = L.pickCandidates(['E1'], names('M', 300), [], cfg);
  assert.strictEqual(noSec.movers.length, 149);
  const cut = L.pickCandidates([], names('M', 300), ['M250'], cfg);
  assert.deepStrictEqual(cut.filers, ['M250']);
  assert.strictEqual(cut.movers.length, 149);
  const top = L.pickCandidates([], names('M', 300), ['M5'], cfg);
  assert.strictEqual(top.movers.length + top.filers.length, 150, 'a held slot is not left empty');
});

check('filers: news-bearing 8-Ks first, smallest market cap first; governance-only last', () => {
  const q = (cap) => ({ marketCap: cap });
  assert.deepStrictEqual(L.rankFilers([
    { ticker: 'VOTE', items: ['5.07'], quote: q(5e6) },
    { ticker: 'BIG', items: ['8.01', '9.01'], quote: q(1.5e9) },
    { ticker: 'SMALL', items: ['1.01', '9.01'], quote: q(40e6) },
    { ticker: 'SPLIT', items: ['5.03'], quote: q(20e6) },
    { ticker: 'NOCAP', items: ['7.01'], quote: {} },
  ]), ['SPLIT', 'SMALL', 'BIG', 'NOCAP', 'VOTE']);
});

console.log('\n' + pass + ' checks passed');
