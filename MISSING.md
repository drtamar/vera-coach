# What's missing

Audited against the code on 2026-10-02, not from memory. Every claim below was
checked by running something; where a count appears, a script produced it.

Ordered by what blocks the most.

---

## 1. Blocking — the camera

**The vision pipeline cannot run in the published artifact.** MediaPipe's WASM is on an
allowed CDN, but its *models* are served from `storage.googleapis.com`, which the artifact
CSP does not permit. `app/sensing/pipeline.mjs` has never run against a real camera anywhere.

This one gap accounts for most of what follows.

- [ ] **13 of 21 drills cannot be run.** 8 are gated on vision metrics outright; 5 more are
      blocked by §2. Only 8 are genuinely runnable today.
- [ ] **3 of 7 live cues can never fire** — `lens_contact_lost`, `hands_dropped`,
      `excessive_sway`. Implemented and unit-tested, unreachable in practice.
- [ ] **Decide the hosting question.** Self-host the MediaPipe models on an allowed origin,
      or accept that the artifact is audio-only and the camera half needs a normal deployment.
      This is a hosting decision, not a code one.

## 2. Blocking — metrics nothing computes

`measurePhase()` returns seven metrics. Ten more appear in graduation predicates and are
never produced, so those drills would fail forever with "not measured".

**This was a live bug until this audit** — those five drills were offered with a Run button.
`runnability()` tested whether a metric was derivable *in principle* rather than whether the
code *actually computes it*. Fixed: it now takes the measured set, and the five drills say
which metric is missing instead of inviting a run that cannot be passed.

- [ ] `speech_onset_latency_s`, `restarts` → unblocks **1.3 Yap Protocol**
- [ ] `word_count_reduction` → unblocks **3.2 Pasta-Sauce** (needs the three-round structure)
- [ ] `scroll_lead_s`, `tempo_variance_wpm` → unblocks **4.2 Three-Speed Cadence**
- [ ] `bridge_latency_s`, `pitch_spike_ratio`, `negative_word_echoes` → unblocks **5.1 ABC Bridging**
- [ ] `vocal_energy_decay`, `conclusion_timing_error_s` → unblocks **5.3 Accordion Energy**

All ten are audio-derivable. None needs the camera.

## 3. Unbuilt mechanics the drills depend on

- [ ] **Teleprompter proper** — 30–45 character column, thought-group chunking, `/` and `//`
      pause notation. The studio has a scroller, not this. Required by 4.1, 4.2, 4.3.
- [ ] **Disruption injection** — prompter freeze, nonsense card, hostile audio, sudden time
      cut. Required by 5.2 Blunder Normalization, whose whole point is recovering from one.
- [ ] **The Vault** — drill 0.1 says keep the first recording and compare later. The registry
      says it; nothing in the studio implements it. The before/after it enables is the only
      honest progress measure in the whole curriculum.

## 4. Tools defined but not implemented

5 of 8 have executors. Three are schemas with nothing behind them:

- [ ] `configure_teleprompter` — blocked on §3
- [ ] `inject_live_disruption` — blocked on §3
- [ ] `generate_diagnostic_scorecard` — including the Pasta-Sauce rewrite of a rambling transcript

## 5. Never verified against reality

Built, tested against fakes, never once exercised for real:

- [ ] **No authenticated API request has ever completed.** Generation and research are covered
      against an injected fake for every failure path; no real call has been made.
      `npm run connect -- --verify` is free and settles it in seconds.
- [ ] **`pipeline.mjs` has never seen a camera.** The metric arithmetic is tested against
      synthesized signals; the MediaPipe wiring is untested.
- [ ] **No live cue has ever been triggered by a real voice.** The governor is tested with
      synthetic ticks and the render path is tested directly, but the full
      audio → rolling window → governor → UI path has never run on actual speech.

## 6. Product gaps

- [ ] **Nothing survives a cleared cache.** Scripts, drill history, graduation streaks and the
      efficacy model are all `localStorage`. No export, no sync, no account.
- [ ] **The efficacy model is invisible.** It learns which drills move your numbers and nothing
      ever shows you that. The product thesis is evidence over badges; this is the evidence.
- [ ] **The on-ramp is orphaned.** `onramp/index.html` is documented and tested, and nothing
      in the studio links to it — so the Stage 0 entry point for someone at zero is unreachable.
- [ ] **No session history across drills** — per-drill streaks exist; there is no view of
      practice over time.

## 7. Honesty debts, already recorded

In `docs/PROVENANCE.md`, repeated here so they are not lost:

- [ ] **Stage 4–5 coach prompts are authored, not transcribed.** The supplied manual truncates
      mid-Stage 4. Replace them if the full document surfaces.
- [ ] **Gaze is an uncalibrated iris-offset approximation**, not the calibrated 3D vector the
      specification describes. It holds only because the drills fix the lens at eye level.
- [ ] **Three source conflicts were resolved unilaterally** in favour of the operational
      document — hands-below-frame tolerance, the Eye Flash mechanic, the No-Tailgating bar.

## 8. Before anyone else uses it

- [ ] **`allowedDomains` is unset for research.** Right for discovery, wrong for a product.
- [ ] **No consent flow or data statement.** Face landmarking engages biometric handling under
      BIPA and GDPR. On-device processing answers most of it; explicit consent and a plain
      statement are still required.
- [ ] **The artifact is private.** Sharing is a decision, not an oversight — but it is undecided.

---

## Not missing

For contrast, and because it is easy to lose track: the 21-drill registry with provenance and
graduation predicates, the composite scoring engine, the acoustic pipeline verified against
synthesized ground truth, the three-tier learning layer with pruning, the cue governor, the
bracketed drill session with real graduation streaks, platform and credential selection,
and 473 tests across twelve suites including a privacy invariant that fails the build if any
module combines media access with network egress.
