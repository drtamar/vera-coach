# VERA

**Virtual Executive Resonance & Authenticity Coach** — an on-camera performance coach that
measures what you actually do and prescribes drills against it.

Most camera coaching is encouragement. This measures gaze fixation, blink rate, gesture
placement, pitch range, terminal inflection, pacing and disfluency, scores them against
published benchmarks, and picks your next drill from the dimension you are actually worst at.

> **Raw video and audio never leave your device.** Sensing runs client-side in WASM; only
> derived numbers cross the wire. This is enforced by a test, not a promise — see
> [Privacy](#privacy).

## What it measures

| Dimension | Target | Deficient | Over-corrected |
|---|---|---|---|
| Speaking pace | 130–150 WPM | >170 rushing | <105 stall |
| Filler density | <1.3% | >4.5% crutches | 0% robotic |
| Lens fixation | 65–80% | <45% evasive | >95% stare |
| Blink rate | 12–22/min | >38 stress flutter | <6 freeze |
| Pitch range | ≥2.5 semitones SD | <1.2 monotone | erratic |
| Terminal inflection | falling | rising (uptalk) | clipped |
| Gesture occupancy | 20–40% TruthPlane | hands below frame | flailing |
| Head tilt | 5–12° | rigid axis | permanent slouch |

Composite score, with weights that adapt per drill:

```
S = w₁·C_gaze + w₂·C_pacing + w₃·C_prosody + w₄·C_stability − P_disfluency
C_pacing = max(0, 1 − |WPM − 140| / 40)
```

## The curriculum

21 drills, six stages, grounded in Tucker, Barr and Caine on screen acting, Rodenburg on
presence, Bowden and Van Edwards on nonverbal signal, Love on vocal prosody, and McGowan and
Phillips on rhetoric.

| Stage | Focus |
|---|---|
| 0 | Baseline — a kept recording and three things you believe. No gating. |
| 1 | Autonomic regulation and lens desensitization |
| 2 | Spatial framing, TruthPlane gestures, warmth and competence |
| 3 | Prosody, message architecture, hedging |
| 4 | Teleprompter fluency |
| 5 | Crisis bridging, blunder recovery, long-form stamina |

Graduation requires benchmarks held across **three consecutive sessions**, never one good
take — behavioral change has to become habit before the next layer lands.

Two failure modes the benchmarks alone miss, carried from the beginner on-ramp:

- **Freezing.** Every drill accepts a "froze, logged anyway" outcome. Freezing is the thing
  being trained out; it cannot be trained without being met.
- **Hedging.** Distinct from disfluency. A speaker can be perfectly fluent and still signal
  they do not believe themselves — "kind of", "I guess", "I'm no expert but". `hedge_density`
  is tracked separately from `filler_density` for exactly this reason.

## The learning layer

The curriculum is a starting point, not a ceiling.

1. **Learn what works on you.** Every drill accumulates per-metric effect evidence from
   within-session pre/post measurements. Selection is Thompson sampling weighted toward your
   weakest dimension.
2. **Generate when stuck.** If a metric stalls and no drill shows trusted positive effect,
   VERA authors a new one to the schema.
3. **Research beyond the manual.** Search out external technique, map it to the schema,
   record provenance.

**What makes this learning rather than accumulation:** generated and researched drills are
pruned when they fail to earn their place. Documented drills are never auto-pruned — one
speaker's null result is not evidence against the curriculum.

The statistics are the hard part, and glossing over them would be the failure mode. With one
speaker and noisy telemetry, attributing a change to a drill is confounded by warm-up,
fatigue, time of day and natural improvement. Three defences: within-session pre/post so
day-to-day variance cancels, shrinkage toward a no-effect prior so two lucky sessions cannot
manufacture a finding, and a minimum trial count before anything influences selection.

**The claim is tested, not asserted.** `tests/core.test.mjs` runs synthetic speakers with
known ground-truth drill effects and asserts the bandit converges on the drill that genuinely
works while pruning the inert ones.

## Privacy

`tests/privacy.test.mjs` statically asserts that no sensing module contains network egress,
that no module anywhere combines media access with a network call (including `server/`, the
half that *will* make network calls), and that the telemetry vector carries nothing but
numbers. It is the one test that must never be allowed to fail.

Face landmarking touches biometric handling under BIPA and GDPR. On-device processing answers
most of it; explicit recording consent and a plain data statement are still required before
this is put in front of anyone.

## Layout

```
registry/drills.json   21 drills: metrics, graduation predicates, protocols, coach cues
app/sensing/           vision.mjs + audio.mjs (pure, testable) · pipeline.mjs (MediaPipe)
app/scoring/           composite score, graduation predicates, three-session gating
app/learning/          effect estimation, Thompson selection, pruning
server/tools.mjs       VERA's 8 tools + the schema gate on generated drills
SKILL.md               VERA's coaching brain — usable directly as a Claude skill
onramp/index.html      the Stage 0–1 beginner UI: self-contained, offline, no build
docs/PROVENANCE.md     every departure from the source documents, and why
```

## Tests

```bash
npm test            # all suites; the browser suite skips if playwright is absent
npm i && npm test   # includes the on-ramp browser suite
```

205 tests: scoring and learning (77), sensing against synthesized ground truth (65), the
privacy invariant (21), tool schemas (21), on-ramp UI in a real browser (21).

## Status

Working and tested: the drill registry, sensing arithmetic, scoring, tier-1 learning, tool
schemas, and the beginner on-ramp UI.

Not yet done:

- **`app/sensing/pipeline.mjs` has never run against a real camera.** The metric arithmetic
  is thoroughly tested; the MediaPipe wiring is not.
- **Learning tiers 2 and 3 are plumbing without the calls.** The stall trigger, schema gate
  and pruning logic exist; no LLM or search call is wired, so nothing can yet produce
  candidates for them to evaluate.
- **There is no UI for stages 1–5.** The on-ramp is the only interface.

## Honesty

The supplied coach manual truncates mid-sentence at Stage 4, so Stage 4–5 coach briefings and
intervention cues are **authored, not transcribed** — each prefixed `AUTHORED.`, with a test
enforcing the prefix is present there and absent from Stages 0–3.

Gaze is an **uncalibrated** iris-offset approximation, not the calibrated 3D vector the
specification describes. It holds only because every drill fixes the lens at eye level at a
known distance.

Three conflicts between the source documents were resolved in favour of the operational one.
All of it is in [docs/PROVENANCE.md](docs/PROVENANCE.md).

## License

Apache-2.0.
