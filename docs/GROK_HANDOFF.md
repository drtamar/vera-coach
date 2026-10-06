# Working with Grok Build

**What it is.** Grok Build is xAI's terminal coding agent. As of May 2026 it is
open to SuperGrok subscribers: plan mode with reviewable steps, parallel
subagents in git worktrees, headless mode, and ACP support. It runs on *your*
machine under *your* subscription, which is why it fits where the studio page
cannot: a published page can never act as your Grok login, but a local agent
signed in as you can.

Verify these details against xAI's own docs before relying on them; they come
from third-party coverage and the product is in beta.

## Why a handoff and not a live connection
The Claude session that maintains this repo runs in a cloud container. It cannot
sign in as you to Grok, and Grok Build cannot reach into that container. The
shared surface is this repository: branches, a test suite that acts as the
contract, and `MISSING.md` as the backlog. That is enough, and it keeps both
agents honest because neither can trust the other's claims — only its tests.

## Install and point it at this repo
```sh
curl -fsSL https://x.ai/cli/install.sh | bash     # then sign in with your SuperGrok account
git clone https://github.com/drtamar/vera-coach && cd vera-coach
git checkout -b grok/<topic> origin/main
```
Tell it to read `AGENTS.md` and this file first, and to start in plan mode.

## Suggested split (minimises merge conflicts)
| Owner | Work | Files it touches |
|---|---|---|
| **Grok Build** | The ten audio metrics (`MISSING.md` §2): `speech_onset_latency_s`, `restarts`, `word_count_reduction`, `scroll_lead_s`, `tempo_variance_wpm`, `bridge_latency_s`, `pitch_spike_ratio`, `negative_word_echoes`, `vocal_energy_decay`, `conclusion_timing_error_s`. Self-contained, test-first against synthesised signals. Parallel subagents in worktrees fit it well, one per metric. | `app/sensing/audio.mjs`, new `tests/*.test.mjs` |
| **Claude** | Accessibility pass, first-run panel, stage gating, studio wiring. | `studio/index.html`, `sandbox/`, `onramp/`, `app/coaching/` |
| **You** | Hosting decision for the MediaPipe models (§1), and consent wording (§9). Neither agent should decide these. | — |

Metrics only count once `studio/index.html` adds them to `MEASURED` and
`measurePhase()` returns them; `runnability()` then unlocks the drills. Do that
wiring in a separate small PR after the metric PR merges, so the two agents never
edit the studio at once.

## Rules of the road
1. One branch per agent per topic: `grok/<topic>`, `claude/<topic>`. Never push
   to the other's branch. Never force-push.
2. Draft PR early, mark ready only when `npm test` is green.
3. The tests are the contract. If you change a test to make your code pass, say
   why in the PR.
4. Review each other's PRs. A second agent reading the diff catches what the
   author's own tests were written to miss — that is the point of using two.
5. Disagreement is resolved by a failing test, not by assertion.

## The voice and persona, on your subscription
The studio's own voice is the browser's speech engine; it cannot produce Grok's
Ara voice. To use Grok's voice with the same coach:
```sh
node bin/export-persona.mjs ara-unhinged     # paste into Grok's custom instructions
```
After a take, the studio's **Take this take to Grok** card copies a review packet
(measurements, persona, transcript) for you to paste into Grok. Nothing is sent
from the page; you carry it.
