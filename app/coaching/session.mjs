/**
 * Running a drill, and what that produces.
 *
 * Everything needed for this existed already and nothing connected it: the
 * registry knows each drill's graduation predicate, score.mjs can evaluate one,
 * and efficacy.mjs can learn from a before/after pair. But nothing ever ran a
 * drill, so `meetsGraduation` was never called on a real take and the learning
 * layer's only inputs were simulations.
 *
 * A session is three measured phases, in this order for a reason:
 *
 *   BASELINE  a short free take, measured BEFORE the drill
 *   DRILL     the drill itself, under its own protocol and duration
 *   POST      a second short take, measured AFTER
 *
 * The bracketing is not ceremony. The efficacy model requires a WITHIN-SESSION
 * pre/post pair — that is what lets day-to-day variance cancel instead of being
 * attributed to the drill. Measuring only after the drill would produce a number
 * that looks like evidence and is not.
 */

import { meetsGraduation, REQUIRED_CONSECUTIVE } from '../scoring/score.mjs';

export const PHASES = ['idle', 'baseline', 'drill', 'post', 'done'];
export const BRACKET_S = 20;      // each measured take either side of the drill

/** Metrics the acoustic pipeline alone can produce. Everything else needs the camera. */
export const AUDIO_METRICS = new Set([
  'wpm', 'filler_density', 'pitch_semitone_sd', 'terminal_pitch_slope',
  'silence_ratio', 'speech_onset_latency_s', 'hedge_density', 'apology_phrases',
  'restarts', 'word_count_reduction', 'pitch_baseline_shift', 'negative_word_echoes',
  'bridge_latency_s', 'pitch_spike_ratio', 'recovery_pause_s', 'vocal_energy_decay',
  'conclusion_timing_error_s', 'tempo_variance_wpm', 'scroll_lead_s', 'transcription_stumbles',
]);

/**
 * Can this drill be run with what the device actually offers?
 *
 * Reported per drill rather than hidden, because "run this drill" and "we cannot
 * tell whether you passed it" are different states and collapsing them would let
 * someone practise against a bar nothing is checking.
 */
export function runnability(drill, { audio = true, vision = false } = {}) {
  if (!drill.telemetry_gated) return { runnable: true, gated: false, missing: [] };
  const bars = Object.keys(drill.graduation || {});
  const missing = bars.filter(m => !(AUDIO_METRICS.has(m) ? audio : vision));
  return { runnable: missing.length === 0, gated: true, missing };
}

/** Per-drill record kept in the store. */
export const emptyRecord = () => ({ reps: 0, sessions: [], streak: 0, graduatedAt: null });

/**
 * Fold one completed session into the store.
 *
 * `pre` and `post` are telemetry vectors from the bracketing takes; `post` is
 * what graduation is judged on, and the pair is what the efficacy model learns
 * from. Returns everything a UI needs to explain the outcome.
 */
export function recordSession(store, drill, { pre, post, at = Date.now(), efficacy = null }) {
  const rec = store[drill.id] || (store[drill.id] = emptyRecord());
  const verdict = drill.telemetry_gated
    ? meetsGraduation(drill, post || {})
    : { pass: true, checks: [] };

  rec.reps += 1;
  // A failed session breaks the run: the documents require the benchmark held
  // across three CONSECUTIVE sessions, not three good days in a month.
  rec.streak = verdict.pass ? rec.streak + 1 : 0;
  rec.sessions.push({ at, passed: verdict.pass, post: post || null });
  if (rec.sessions.length > 30) rec.sessions = rec.sessions.slice(-30);

  const graduated = rec.streak >= REQUIRED_CONSECUTIVE;
  if (graduated && !rec.graduatedAt) rec.graduatedAt = at;

  const observations = [];
  if (efficacy && pre && post) {
    for (const metric of drill.target_metrics || []) {
      if (!Number.isFinite(pre[metric]) || !Number.isFinite(post[metric])) continue;
      observations.push({ metric, improvement: efficacy.record(drill.id, metric, pre[metric], post[metric]) });
    }
  }

  return {
    passed: verdict.pass,
    checks: verdict.checks,
    streak: rec.streak,
    needed: REQUIRED_CONSECUTIVE,
    graduated,
    justGraduated: graduated && rec.graduatedAt === at,
    observations,
    // no pre/post pair means nothing was learned — say so rather than implying it
    learned: observations.length > 0,
  };
}

/**
 * Which drill to offer next.
 *
 * Bandit-driven when there is evidence and a weak metric to aim at; otherwise
 * the first unfinished drill in curriculum order, because an untrained model
 * choosing at random is worse than the syllabus.
 */
export function recommend({ drills, store, efficacy, weakest, caps }) {
  const eligible = drills.filter(d => runnability(d, caps).runnable);
  if (!eligible.length) return null;

  const unfinished = eligible.filter(d => (store[d.id]?.streak ?? 0) < REQUIRED_CONSECUTIVE);
  const pool = unfinished.length ? unfinished : eligible;

  if (weakest && efficacy) {
    const aimed = pool.filter(d => (d.target_metrics || []).includes(weakest));
    if (aimed.length) {
      const pick = efficacy.select(aimed, weakest);
      if (pick) return { drill: pick, why: `aimed at ${weakest}, your weakest dimension` };
    }
  }
  const next = pool.slice().sort((a, b) => a.stage - b.stage || a.id.localeCompare(b.id))[0];
  return { drill: next, why: 'next in the curriculum' };
}

/** Stage progress: a stage is cleared when every gated drill in it has graduated. */
export function stageProgress(drills, store) {
  const byStage = new Map();
  for (const d of drills) {
    const s = byStage.get(d.stage) || { stage: d.stage, total: 0, done: 0 };
    s.total += 1;
    if ((store[d.id]?.streak ?? 0) >= REQUIRED_CONSECUTIVE) s.done += 1;
    byStage.set(d.stage, s);
  }
  return [...byStage.values()].sort((a, b) => a.stage - b.stage);
}
