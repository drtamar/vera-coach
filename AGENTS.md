# Working in this repo (for any coding agent)

On-camera performance coach. Sensing runs on-device; the studio is a static page
that imports the real modules over HTTP.

## Before you push
- `npm test` must pass. Browser suites skip cleanly without Playwright
  (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i --no-save playwright`, Chromium path
  is `/opt/pw-browsers/chromium` in the cloud container; use your own locally).
- Every fix lands with a test that fails without it. Force the failure; do not
  stub around it.
- Do not weaken the privacy invariant (`tests/privacy.test.mjs`): no module may
  combine media access with network egress.
- Do not edit `FLOOR` in `app/coaching/persona.mjs` to make a persona friendlier.
  It is the honesty rule every persona inherits.
- Never invent a metric. A metric the code does not compute is "not measured".

## Backlog
`MISSING.md` is the source of truth. Claim an item by putting your branch name on
its line in your first commit; tick it off in the commit that fixes it. If a claim
and the code disagree, the code wins — correct the doc.

## Collaborating across agents
See `docs/GROK_HANDOFF.md` for the Claude + Grok Build split and branch rules.
