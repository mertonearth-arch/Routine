# Run procedure

Each scheduled run is a fresh cloud session that follows this file. Two runs a weekday:
**AM** (06:27 Stockholm, about 00:27 New York) and **PM** (22:07 Stockholm, just after the
US close). Both do the same thing; only the `--run` label differs.

The repo is code only. A run never commits or pushes. Its results, and the history the
next run continues from, live on the published dashboard (`ARTIFACT.md` has the link) as
`data/history.json` and `data/latest.json` next to the page.

## Steps

1. **Get the code.**
   ```
   git clone --depth 1 https://github.com/mertonearth-arch/Routine routine
   cd routine
   mkdir -p out
   ```

2. **Pick up where the last run stopped.** Read the dashboard URL from `ARTIFACT.md`, then:
   - `Artifact` with `action: "read"` and that `url` (a fresh session must view the page
     before it may publish to it);
   - `Artifact` with `action: "read"`, the same `url` and `path: "data/history.json"`, then
     copy the saved file it reports to `out/history.json`. If the file does not exist yet,
     skip this; the scan starts with a 24-hour window.

3. **Scan.**
   ```
   node bin/scan.js --run am      # or --run pm
   ```
   Give the command up to 10 minutes. It backs off when Yahoo rate-limits and stops itself
   at 8 minutes, recording anything unchecked. It writes `out/latest.json` and adds this run
   to `out/history.json`.

4. **Check the hits against their sources.** For each entry in `hits` of `out/latest.json`
   (at most 8), open the primary source — the company release or filing link on the event;
   if there is none, search for the headline — and confirm the event and its date. Write
   `out/review.json`:
   ```json
   { "reviewedAt": "<ISO time>", "items": [
     { "ticker": "KRRO", "verdict": "confirmed", "note": "Orphan Drug Designation confirmed in Korro release, 07:00 ET" }
   ] }
   ```
   `verdict` is `confirmed`, `relabel` (the event is real but the label is wrong, e.g. an ATM
   *termination* labelled as an offering) or `unverified` (no primary source found). Keep
   each `note` under 90 characters and factual. They print under each hit as Verified,
   Unverified or Relabel.

5. **Build.**
   ```
   node bin/build.js
   ```

6. **Publish.** `Artifact` with `file_path: out/index.html`, `url` set to the dashboard URL,
   and `files: { "data/history.json": "out/history.json", "data/latest.json": "out/latest.json" }`.
   Never publish without `url` (that would create a second dashboard). If the publish is
   refused because the page was not read, read it once and publish again.

7. **Notify.** If there was at least one hit, send one `PushNotification`:
   `Small-float AM: KRRO (regulatory / clinical), GMRS (buyback / dividend)` (PM for the
   evening run). Add `partial run` if `sources.coverage.partial` is true. No notification
   when there are no hits.

8. **Report back** in three to five lines: hits with their event types, dilution or negative
   items, the review verdicts, whether the run was degraded (Yahoo session failed), partial
   (`sources.coverage`) or ran without SEC (`sources.sec.enabled` false), and the dashboard link.

## Rules

- No scores, ratings, opinions, trade calls or price targets. "Positive-type" is an event
  label. Facts with dates and sources only.
- Never invent a number. If something could not be established, say so.
- State a degraded or partial run first; never imply a check ran when it did not.
- GlobeNewswire, ACCESS Newswire and Newsfile block automated clients on purpose. Do not try
  to get around that; their releases arrive through Yahoo's headline feed.
- Do not edit, commit or push the repo from a scheduled run.
