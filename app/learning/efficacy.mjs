/**
 * The self-learning layer.
 *
 * The claim "the agent learns" is only honest if generated and researched
 * drills are held to the same evidential standard as the documented ones. That
 * is what this module enforces: every drill, whatever its origin, accumulates
 * per-metric effect evidence, selection is driven by that evidence, and drills
 * that do not earn their place are retired.
 *
 * The hard part is statistical, not architectural. With one user and noisy
 * telemetry, a raw before/after difference across sessions is confounded by
 * warm-up, fatigue, time of day and natural improvement. Three defences:
 *
 *   1. Evidence is a WITHIN-SESSION pre/post delta, so day-to-day variance
 *      cancels instead of being attributed to the drill.
 *   2. Estimates are shrunk toward a no-effect prior, so two lucky sessions
 *      cannot manufacture a large effect.
 *   3. Nothing influences selection or pruning until it clears a minimum
 *      trial count.
 */

import { improvement } from '../scoring/score.mjs';

export const PRIOR_MEAN = 0;      // assume no effect until shown otherwise
export const PRIOR_WEIGHT = 4;    // pseudo-observations of shrinkage
export const OBS_SD = 0.5;        // assumed per-observation noise, band-widths
export const MIN_TRIALS_TO_TRUST = 3;
export const MIN_TRIALS_TO_PRUNE = 6;

const key = (drillId, metric) => `${drillId}::${metric}`;

export class EfficacyModel {
  constructor(state) {
    this.obs = new Map();
    if (state?.obs) for (const [k, v] of Object.entries(state.obs)) this.obs.set(k, { ...v });
  }

  toJSON() {
    return { obs: Object.fromEntries(this.obs) };
  }

  /**
   * Record one within-session observation: the target metric measured
   * immediately before and immediately after the drill, in the same sitting.
   */
  record(drillId, metric, before, after) {
    const imp = improvement(metric, before, after);
    const k = key(drillId, metric);
    const cur = this.obs.get(k) || { n: 0, sum: 0, sumsq: 0 };
    cur.n += 1;
    cur.sum += imp;
    cur.sumsq += imp * imp;
    this.obs.set(k, cur);
    return imp;
  }

  /** Shrunk posterior over a drill's effect on one metric, in band-widths. */
  effect(drillId, metric) {
    const o = this.obs.get(key(drillId, metric)) || { n: 0, sum: 0, sumsq: 0 };
    const n = o.n;
    const sampleMean = n ? o.sum / n : 0;
    const mean = (n * sampleMean + PRIOR_WEIGHT * PRIOR_MEAN) / (n + PRIOR_WEIGHT);
    const sd = OBS_SD / Math.sqrt(n + PRIOR_WEIGHT);
    return { mean, sd, n, trusted: n >= MIN_TRIALS_TO_TRUST };
  }

  /**
   * Thompson sampling over candidate drills for one target metric: sample each
   * drill's effect from its posterior and take the argmax. Uncertainty is
   * explored automatically, because a drill with little evidence has a wide
   * posterior and will occasionally win.
   */
  select(drills, metric, rng = Math.random) {
    if (!drills.length) return null;
    let best = null, bestDraw = -Infinity;
    for (const d of drills) {
      const { mean, sd } = this.effect(d.id, metric);
      const draw = gaussian(mean, sd, rng);
      if (draw > bestDraw) { bestDraw = draw; best = d; }
    }
    return best;
  }

  /**
   * Retire generated and researched drills that have had a fair trial and not
   * earned their place. Documented and original drills are never auto-pruned:
   * they are the curriculum, and a drill failing for one user is not evidence
   * against the manual.
   */
  prune(drills) {
    const out = [];
    for (const d of drills) {
      if (d.source === 'documented' || d.source === 'original') continue;
      for (const metric of d.target_metrics || []) {
        const e = this.effect(d.id, metric);
        if (e.n >= MIN_TRIALS_TO_PRUNE && e.mean <= 0) {
          out.push({ id: d.id, metric, mean: e.mean, n: e.n });
          break;
        }
      }
    }
    return out;
  }

  /**
   * Has a metric stalled? True when recent evidence across the whole registry
   * shows no drill making trusted positive progress on it. This is the trigger
   * for generating or researching something new.
   */
  stalled(drills, metric) {
    const relevant = drills.filter(d => (d.target_metrics || []).includes(metric));
    if (!relevant.length) return true;
    return !relevant.some(d => {
      const e = this.effect(d.id, metric);
      return e.trusted && e.mean > 0;
    });
  }
}

/** Box-Muller. */
function gaussian(mean, sd, rng = Math.random) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** The user's weakest documented dimension, which drives drill selection. */
export function weakestMetric(telemetry, targets) {
  let worst = null, worstDist = 0;
  for (const [metric, t] of Object.entries(targets)) {
    const v = telemetry[metric];
    if (!Number.isFinite(v)) continue;
    const [lo, hi] = t.band;
    const width = (hi - lo) || t.tol;
    const dist = v < lo ? (lo - v) / width : v > hi ? (v - hi) / width : 0;
    if (dist > worstDist) { worst = metric; worstDist = dist; }
  }
  return worst ? { metric: worst, distance: worstDist } : null;
}
