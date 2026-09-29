# Provenance and editorial decisions

Everything in `registry/drills.json` traces to one of three source documents, or is marked
as original. This file records where the implementation departed from those sources and why.

The sources are not distributed with this repository. They are:

1. **A pedagogical curriculum** — five levels, fifteen drills, with computer-vision and
   audio-DSP metrics, target ranges and the composite scoring formula.
2. **An operational coach manual** — the same curriculum written as a coach's syllabus, with
   concept briefings, step-by-step protocols, intervention cues and graduation benchmarks.
3. **An agent architecture specification** — VERA's persona, skill modules, tool surface,
   production system prompt and benchmark matrix.

Drill `provenance.document` fields cite these as `curriculum`, `coach-manual` and
`agent-architecture` respectively, with section numbers.

## Authored content

The coach manual as supplied **truncates mid-sentence partway through Stage 4** — the text
ends at "trains peripheral absorption, scroll-lead". Stage 4 and 5 drill *content* exists in
the curriculum document, but their coach briefings and intervention cues do not exist in any
supplied source.

Coach briefings and cues for drills **4.1, 4.2, 4.3, 5.1, 5.2 and 5.3 are authored**, written
in the established voice of the manual's Stages 1–3. Every one is prefixed `AUTHORED.` in
the registry, and a test asserts that prefix is present on all Stage 4–5 drills and absent
from Stage 0–3. If the full manual becomes available, these should be replaced.

## Source conflicts

| Drill | Conflict | Resolution |
|---|---|---|
| 2.1 TruthPlane | Curriculum flags hands below frame at >5s; coach manual stops the take at >3s | 3s — the manual is the operational document |
| 2.3 Micro-Stillness | Curriculum describes the Eye Flash as briefly closing the eyes; manual describes dropping gaze downward | Manual's version, same reasoning |
| 3.3 No-Tailgating | Curriculum sets the drill filler bar at <0.8%; the system-wide benchmark elsewhere is <1.3% | 0.8% as this drill's graduation bar, 1.3% as the global threshold |

## Implementation departures

**Gaze is uncalibrated.** The specification describes a 3D gaze vector projected against a
bounding sphere at the lens aperture. The implementation uses normalized iris offset within
the eye aperture. This is a genuine approximation — it holds only because every drill's
setup mandates the lens at eye level at 2.5–3ft, which collapses "iris centred" and "looking
at the lens" into nearly the same statement. It is reported as an approximation, not dressed
up as a calibrated vector.

**`right` removed from the filler lexicon.** The source names "um, like, you know" as target
fillers. A naive lexicon including `right` produces false positives on ordinary speech
("the right call", "turn right", "that's right") at a rate the graduation bars — 0.8% and
1.3% — cannot absorb. `like` is retained per the source, but carries the same ambiguity
("felt like a fraud") and gives `filler_density` a small positive bias for speakers who use
simile heavily. Proper disambiguation needs part-of-speech tagging.

**Terminal pitch slope band corrected.** An initial band of `[-99, 0]` gave a normalizing
width of 99, which made uptalk mathematically incapable of ever registering as a speaker's
weakest metric. Corrected to `[-5, 0]`, a realistic semitone slope range over a 500ms window.

**Component formulas.** Only `C_pacing` is given explicitly in the source. `C_gaze`,
`C_prosody` and `C_stability` are built from one shared band-score primitive — full credit
inside the documented target range, linear decay across a tolerance outside it — so that all
four components sit on the same 0..1 footing and the documented weights mean what they say.

## Original content

Six drills (0.1, 0.2, 1.4, 1.5, 1.6, 3.4) are marked `source: "original"`. They come from the
beginner on-ramp and have no equivalent in the supplied curriculum. They address two failure
modes the benchmarks do not catch:

- **Freezing** — every drill accepts a "froze, logged anyway" outcome, because freezing is
  the thing being trained out and cannot be trained without being met.
- **Hedging** — distinct from disfluency. A speaker can be perfectly fluent and still signal
  they do not believe themselves. `hedge_density` is tracked separately from `filler_density`
  for exactly this reason.
