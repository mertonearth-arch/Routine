# Routine — small-float scan

Twice every weekday this scans US-listed stocks with a **float under 50 million shares or a
market cap under $300 million** for good news and good financials, and publishes one page:
each stock's float and market cap drawn to scale against those two lines, what happened,
where it was published, and the dilution it may bring.

The dashboard link is in [`ARTIFACT.md`](ARTIFACT.md).

## What it looks for

**Qualifies:** float ≤ 50M shares (or shares outstanding ≤ 50M, which bounds float) with
market cap ≤ $2B, **or** market cap ≤ $300M. The $2B guard exists because companies like NVR,
AutoZone and FICO also have fewer than 50M shares and are not low-float names. Common stock
on Nasdaq, NYSE and NYSE American only: no OTC, warrants, units, rights or preferreds.

**A hit:** a positive-type event in the window from a company release, an SEC filing or a
news outlet — an order or contract, an FDA decision, a buyback, a renewal, regained listing
compliance, a partnership — or an earnings report whose numbers show revenue up 25% or more
year over year, a turn to profit, or a loss narrowed by 25% or more. Commentary sites, analyst
actions and product launches never make a hit on their own. Two outlets describing one print
differently ("loss widens" vs "beats estimates") is contested and does not count.

**Not a hit twice:** a stock's news gets retold for days ("Update: …", "Why X stock soared",
a second outlet, the 10-Q after the earnings release). For 10 days after a hit, a positive
story counts as new only if it is a different story. When two thirds of its content words
were in an earlier hit's headline (company name, ticker and words like "shares" or "soars"
left out) and no amount, product code or quarter contradicts it, the page lists it as not
counted instead. "$75M buyback" retold is a repeat; "additional $50M buyback" is new. The
same quarter's numbers count once.

**Next to every hit:** offerings, ATMs, warrant deals, reverse splits, listing notices and
setbacks on small floats, and, for 10 days after a hit, any dilution that follows it.

**Share count history:** every name on the page shows its share count over the last ~18
months (Yahoo's quarterly figures, split-adjusted) and any reverse split in the last two
years, so serial dilution shows even with SEC off. A count up 30% or more over that span,
or any reverse split, prints in red: "4.1M (Jun 2025) → … → 87.2M (Sep 2026), ×21.3".

Event types are keyword labels read from headlines. They mark where to look; they are not
ratings and not a reason to buy.

**Which names get checked:** up to 150 a run (Yahoo throttles bigger runs). Earlier hits
first, then the day's biggest movers (up 5% or more). With SEC on, up to 40 of the 150 go
to companies that filed an 8-K in the window without moving, smallest market cap first and
governance-only filings (vote results, officer changes) last. A big filing day therefore
cannot push the movers out, and a busy tape cannot push the filings out. Those filers are
sized with one batch quote per 50 names and go through the same price, volume and cap
filter as the movers.

## How it runs

Two scheduled routines (weekdays 06:27 and 22:07 Stockholm time) run in the **Routine**
cloud environment, whose network allows only Yahoo Finance and SEC EDGAR. Each run follows
[`ROUTINE.md`](ROUTINE.md): clone this repo, download the run history from the dashboard,
scan from where the last run stopped, check each hit against its source, rebuild the page and
publish it with the updated history. Runs never push to git, so this repo stays code-only.

## Setup: SEC filings

SEC EDGAR requires automated clients to declare a contact. Until `SEC_USER_AGENT` is set as
a variable on the Routine environment, the scan skips SEC (no 8-K feed, no 90-day dilution
filing check) and the page says "off". Set it in the environment's settings (cloud
environment menu in a session's title bar, then Edit, Environment variables) as
`SEC_USER_AGENT=you@example.com`; the scan puts its own name in front. It is deliberately
not in this public repo. The next run picks it up. If EDGAR then refuses the requests, the
page says "failed" with the reason, not "off".

## Commands

```
npm run scan -- --run am     # scan; writes out/latest.json and out/history.json
npm run build                # renders out/index.html
npm test                     # rules, history and page tests
```

Node 22.21 or newer; no dependencies. Thresholds are in `scan.config.json`.

## Limits

- The AM run fires around 00:27 New York time, before pre-market news; the PM run is just
  after the close. This is a research log, not a real-time alert: low-float news moves within
  minutes.
- Float comes from Yahoo key statistics. When Yahoo refuses a session, the run uses shares
  outstanding as the bound, checks fewer names, and marks itself degraded.
- Yahoo rate-limits shared cloud IPs. The scan backs off and retries, and marks the run
  partial if any qualifying names could not be checked.
- EDGAR's submissions API labels acceptance times "Z" but has served New York clock time on
  some filings. Times come from the 8-K feed, which carries its offset. A filing whose time
  cannot be settled prints with its date only and may appear in two consecutive runs
  rather than in none.
- Repeats are matched by words. A retelling in different words still counts twice, and a
  new event told in the same words (the same designation granted in another region) is
  not counted. The page lists every story it left out, so nothing disappears silently.
- Share counts are quarterly, so an offering priced since the last report is not in them
  yet (the SEC dilution check and the dilution section cover that).
- An earnings hit uses Yahoo's numbers only if the newest quarter on file ended within 100
  days of the release. Otherwise Yahoo still holds the previous report, and it is not used.
- Keyword labels are sometimes wrong. Each run checks its hits against the source and prints
  the verdict (Verified, Unverified or Relabel) under each hit.

## Files

```
bin/scan.js       the scan
bin/build.js      renders the page
lib/scan.js       rules: qualification, headline labels, financial checks
lib/history.js    run history carried on the dashboard
lib/page.js       the report page (float and cap meters, events, checks)
lib/model.js      turns a run into page fields; lib/format.js formatting
lib/yahoo.js, lib/sec.js, lib/http.js   read-only data access
scan.config.json  thresholds
ROUTINE.md        what each scheduled run does
```
