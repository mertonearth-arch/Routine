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

**Next to every hit:** offerings, ATMs, warrant deals, reverse splits, listing notices and
setbacks on small floats, and, for 10 days after a hit, any dilution that follows it.

Event types are keyword labels read from headlines. They mark where to look; they are not
ratings and not a reason to buy.

## How it runs

Two scheduled routines (weekdays 06:27 and 22:07 Stockholm time) run in the **Routine**
cloud environment, whose network allows only Yahoo Finance and SEC EDGAR. Each run follows
[`ROUTINE.md`](ROUTINE.md): clone this repo, download the run history from the dashboard,
scan from where the last run stopped, check each hit against its source, rebuild the page and
publish it with the updated history. Runs never push to git, so this repo stays code-only.

## Setup: SEC filings

SEC EDGAR requires automated clients to declare a contact. Until `SEC_USER_AGENT` is set as
a variable on the Routine environment, the scan skips SEC (no 8-K feed, no 90-day dilution
filing check) and the page says so. Set it to a name and your email, e.g.
`RoutineScanner you@example.com`, in the environment's settings (cloud environment menu in
a session's title bar, then Edit). It is deliberately not in this public repo.

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
