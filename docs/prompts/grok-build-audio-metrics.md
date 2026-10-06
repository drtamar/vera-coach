# Prompt for Grok Build: the ten uncomputed audio metrics

Paste everything below the line into Grok Build (start it in plan mode).

---

You are joining an existing repository, `drtamar/vera-coach`, as a coding agent. Another agent (Claude) maintains the studio UI in the same repo. Your job is one self-contained piece: implement ten speech metrics as pure, tested functions. Read this whole brief before touching anything, then **start in plan mode and show me the plan before editing**.

## 1. Context

VERA is an on-camera performance coach. All sensing runs on the user's device; the studio is a static page that imports the real modules over HTTP. A drill is only offered to the user if every metric in its graduation bar is actually *computed* by the studio. Ten metrics appear in graduation bars and nothing computes them, so five drills can never be run. You are building those ten. They are all derivable from audio and a transcript. None needs the camera.

Read these first, in this order:
1. `AGENTS.md` and `docs/GROK_HANDOFF.md` (rules of the road, branch rules, what you own).
2. `MISSING.md` section 2 (the backlog item you are closing).
3. `app/sensing/audio.mjs` (the module you extend; note its conventions).
4. `app/coaching/session.mjs` (`runnability`, `AUDIO_METRICS`, how metrics gate drills).
5. `registry/drills.json` (the graduation bars, quoted in section 3).
6. `tests/sensing.test.mjs` (the style your tests must follow: synthesised ground-truth signals).

Branch from `claude/funny-lamport-m649bb` (it carries `AGENTS.md` and the handoff doc) as `grok/audio-metrics`. Do not push to any `claude/*` branch. Never force-push. Open a **draft** PR against `main` when you have something reviewable.

## 2. Hard constraints

- **No studio wiring.** Do not edit `studio/index.html`, `sandbox/`, `onramp/`, or the `MEASURED` set. Claude does that in a separate PR after yours merges, so we never edit the studio at once.
- **No new dependencies.** ES modules, Node >= 20, and the code must run unchanged in a browser. No Node-only APIs, no network, no `fetch`/`WebSocket`/`sendBeacon`. `tests/privacy.test.mjs` fails the build if a module combines media access with network egress; do not weaken it.
- **Honest nulls.** If the input is insufficient to measure a metric, return `null`. Never return `0`, a default, or a guess. A fabricated number looks like evidence and is the failure this whole system exists to avoid. Document the exact conditions that give `null`.
- **Do not edit** `FLOOR` in `app/coaching/persona.mjs`, the thresholds in `registry/drills.json`, or any existing test to make your code pass. If you believe an existing test or threshold is wrong, stop and say why in the PR instead.
- **Precision over recall where the bar is `== 0`.** Several bars fail a speaker on a single hit. A false positive fails someone who was fluent. Bias your detectors conservative and say so.
- **One metric = one pure function.** Explicit inputs, deterministic, no hidden state, no `Date.now()`, no randomness.

## 3. The ten metrics

Shared conventions already in `audio.mjs`: energy is an array of RMS values, one per frame; pitch is an array of Hz or `null` (unvoiced), one per frame; `frameMs` is 20; the silence floor is `0.01`; `yinPitch`, `rms`, `silenceProfile`, `wordsPerMinute`, `negativeEchoes`, `apologyCount` exist and should be reused, not reimplemented. The browser's speech recognition returns **final text per segment with no word timestamps**, so anything needing timing must accept timestamps as an input rather than assume them. Say so in the doc comment.

For each: signature, definition, `null` conditions, and the bar it feeds.

| # | Metric | Drill and bar | Definition you must implement |
|---|---|---|---|
| 1 | `speechOnsetLatency(energy, frameMs, cueFrame, {floor, minVoicedMs})` -> `speech_onset_latency_s` | 1.3 Yap: `< 2.0` | Seconds from the cue frame to the first frame that starts a voiced run of at least `minVoicedMs` (default 100). `0` if already voiced at the cue. `null` if no speech after the cue, or the cue is out of range. |
| 2 | `countRestarts(transcript)` -> `restarts` | 1.3 Yap: `== 0` | Count explicit restarts: restart phrases ("let me start again", "start over", "scratch that", "sorry, I", "no wait") plus an immediate repeat of the same opening 3+ words within the next 12 words. Reuse `apologyCount`'s phrase machinery where sensible. `null` for an empty transcript. **Conservative**: a speaker who says "I mean it" or repeats a word for emphasis must not count. Include those as negative tests. |
| 3 | `wordCountReduction(firstTranscript, finalTranscript, {minWords})` -> `word_count_reduction` | 3.2 Pasta-Sauce: `>= 0.75` | `1 - finalWords / firstWords`, not clamped (document that it can be negative if the speaker got longer). `null` if the first take has fewer than `minWords` (default 20), since a ratio of tiny counts is noise. |
| 4 | `scrollLead(chunks)` -> `scroll_lead_s` | 4.2 Cadence: `between 0.5 and 1.0` | `chunks` is `[{scrollMs, voiceOnsetMs}]`, one per thought-group (the teleprompter does not exist yet; accept the data it will produce). Median of `(voiceOnsetMs - scrollMs) / 1000`. `null` for fewer than 3 usable chunks. Document the sign convention in one sentence and test it. |
| 5 | `tempoVariance(passes)` -> `tempo_variance_wpm` | 4.2 Cadence: `>= 20` | `passes` is `[{transcript, durationS}]`. Population standard deviation of the per-pass `wordsPerMinute`. `null` for fewer than 2 passes or any pass with no words. The intended passes are 110, 170, 140 WPM; a test must show those satisfy the bar and three identical passes do not. |
| 6 | `bridgeLatency(segments, questionEndMs)` -> `bridge_latency_s` | 5.1 ABC: `<= 8` | `segments` is `[{text, startMs}]`. Seconds from `questionEndMs` to the start of the first segment containing a bridge phrase ("what is critical to focus on is", "the broader priority here is", "what matters here is", "the important thing is", "what I would say is"). `null` if no bridge phrase appears. Do not invent one. |
| 7 | `pitchSpikeRatio(pitchHz, {semitones, minVoiced})` -> `pitch_spike_ratio` | 5.1 ABC: `< 0.1` | Fraction of voiced frames more than `semitones` (default 4) above the take's median voiced pitch. Use `hzToSemitones`. `null` below `minVoiced` voiced frames (default 50). Export the default as a named constant so it can be tuned in one place. |
| 8 | `negativeWordEchoes(answerTranscript, questionText)` -> `negative_word_echoes` | 5.1 ABC: `== 0` | Extract the loaded terms from the **question** using a small, exported negative-framing lexicon (fail, failure, scandal, crisis, disaster, lawsuit, layoffs, fired, collapse, ...), match inflections (fail/failed/failing/failure), then count how many times the **answer** repeats them via the existing `negativeEchoes`. `null` if either input is empty. Note: the existing matcher is whole-word, so "delays" will not match "delay"; handle stems and test it. |
| 9 | `vocalEnergyDecay(energy, {floor})` -> `vocal_energy_decay` | 5.3 Accordion: `< 0.1` | Using **voiced frames only** (energy above floor), compare mean RMS of the last third of the take to the first third: `max(0, (first - last) / first)`. Voiced-only, because the pauses are not energy loss. `null` if either third has too few voiced frames. Explain in a comment why last-vs-first third and not a whole-take slope: the drill deliberately modulates energy across phases. |
| 10 | `conclusionTimingError(energy, frameMs, cueFrame, {targetS, floor})` -> `conclusion_timing_error_s` | 5.3 Accordion: `<= 5` | `abs(endOfSpeechS - (cueS + targetS))` where end of speech is the last voiced frame after trimming trailing silence, `targetS` defaults to 60. `null` if there is no speech after the cue. |

## 4. Where the code goes

So that work can be parallelised without merge conflicts:

- One new file per metric under `app/sensing/metrics/` (for example `app/sensing/metrics/speech-onset-latency.mjs`), each exporting its function and any named constants.
- `app/sensing/metrics/index.mjs` re-exports all ten and exports `DERIVED_AUDIO_METRICS`, a map from registry metric name to function. Whoever integrates writes this file last.
- One test file per metric under `tests/metrics/`, plus `tests/audio-metrics.test.mjs`, which imports them all and prints one `N passed, M failed` line. Register that single suite in `tests/run.mjs`.
- Import helpers from `app/sensing/audio.mjs`. Do not move or rename anything already exported there.

If you use parallel subagents in worktrees, give each one metric (or two related ones) and one file. They must not edit `index.mjs`, `tests/run.mjs` or `MISSING.md`; you integrate those once the metric files are merged.

## 5. Tests are the contract

Follow `tests/sensing.test.mjs`: synthesise a signal whose answer is known, then assert the function recovers it. Concretely, every metric needs:

- A **recovery test** from a synthesised input with a known answer (a tone that steps in amplitude for energy decay; a pitch track with a known fraction of spikes; three transcripts of known word counts for tempo; and so on). Use a tolerance, not exact equality, for anything derived from signals.
- A **bar test**: an input that should pass the drill's graduation bar and one that should fail it, evaluated through `meetsGraduation` from `app/scoring/score.mjs`, so you prove the number is usable where it will be used.
- A **null test** for every documented `null` condition.
- For metrics 2 and 8, at least five **negative tests** (fluent speech that must not be flagged).
- Assert that nothing returns `NaN` or `Infinity` for empty arrays, zero durations or all-silent input.

Every fix or feature must have a test that **fails without it**. Show me one failing run first, then the passing run. Do not stub around a failure.

## 6. Verification before you push

Run, and show the output of:

```sh
npm test                               # all suites, must be green
node tests/audio-metrics.test.mjs      # your suite alone
node tests/privacy.test.mjs            # must still pass
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i --no-save playwright   # then npm test again to include the browser suites
```

Then re-read your own diff adversarially: what input makes each function return a confident wrong answer? Fix what you find, or list it as a known limit in the PR.

## 7. Documentation

- In `MISSING.md` section 2, tick each metric only as **"implemented as a pure function; not yet measured in the studio"**. Do not claim a drill is runnable. The drills unlock only when the studio's `measurePhase()` returns the metric and it joins `MEASURED`, which is the next PR.
- Note in the PR which of the five drills (1.3, 3.2, 4.2, 5.1, 5.3) still need something other than a metric to be run: a teleprompter (4.2), disruption injection and audio prompts (5.1), a three-round structure (3.2), and a long-form mode with a mid-take cue (5.3). Those are listed in `MISSING.md` section 3. Do not build them.
- Where a metric needs word timing the browser does not provide (4, 6), say plainly in the doc comment what the studio will have to supply and how coarse that data will be.

## 8. How I want you to work

1. Plan mode first. List the files you will create, the order, and what you will run to verify. Wait for my approval.
2. Test-first, one metric at a time. Commit per metric with a message that says what the metric measures and why its `null` conditions are what they are.
3. When a definition above is ambiguous or you think it is wrong, **stop and ask** rather than choosing silently. The thresholds come from a source document and are not yours to adjust.
4. Open a draft PR early. Mark it ready only when `npm test` is green.
5. Finish with a short report: what is done, what each function returns when it cannot measure, what you are unsure about, and what the studio integration PR will need.
