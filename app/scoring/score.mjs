/**
 * Composite Confidence Score.
 *
 *   S = w1*C_gaze + w2*C_pacing + w3*C_prosody + w4*C_stability - P_disfluency
 *   C_pacing = max(0, 1 - |WPM - 140| / 40)
 *
 * The specification gives C_pacing explicitly and describes the others
 * qualitatively, so the remaining components are built from one shared
 * band-score primitive: full credit inside the documented target range,
 * decaying linearly to zero across a tolerance outside it. That keeps every
 * component on the same 0..1 footing so the weights mean what they say.
 */

export const TARGETS = {
  gaze_fixation_ratio:   { band: [0.65, 0.85], tol: 0.25 },
  blink_rate:            { band: [12, 22],     tol: 16   },
  truth_plane_occupancy: { band: [0.40, 0.70], tol: 0.40 },
  head_tilt_angle:       { band: [5, 12],      tol: 10   },
  wpm:                   { band: [130, 150],   tol: 40   },
  pitch_semitone_sd:     { band: [2.5, 6.0],   tol: 2.5  },
  terminal_pitch_slope:  { band: [-5, 0],     tol: 1.0  },
  filler_density:        { band: [0, 0.013],   tol: 0.04 },
};

const DISFLUENCY_THRESHOLD = 0.013;   // 1.3% of spoken words
const TORSO_LIMIT_CM = 2.0;

/** Full credit inside [lo,hi]; linear decay to 0 across `tol` beyond it. */
export function band(value, [lo, hi], tol) {
  if (!Number.isFinite(value)) return 0;
  if (value >= lo && value <= hi) return 1;
  const d = value < lo ? lo - value : value - hi;
  return Math.max(0, 1 - d / tol);
}

/**
 * Signed, scale-free improvement toward a metric's target band, expressed in
 * band-widths. Positive means the take moved toward the target. This is what
 * the efficacy model consumes, so that a WPM drill (hundreds) and a gaze drill
 * (0..1) contribute comparable evidence.
 */
export function improvement(metric, before, after) {
  const t = TARGETS[metric];
  if (!t) return 0;
  const [lo, hi] = t.band;
  const width = (hi - lo) || t.tol;
  const dist = v => (v < lo ? lo - v : v > hi ? v - hi : 0);
  return (dist(before) - dist(after)) / width;
}

/** band() applied to a named metric's documented target. */
export function bandOf(metric, value) {
  const t = TARGETS[metric];
  return t ? band(value, t.band, t.tol) : 0;
}

export const WEIGHT_PROFILES = {
  default:      { gaze: 0.25, pacing: 0.25, prosody: 0.25, stability: 0.25 },
  teleprompter: { gaze: 0.50, pacing: 0.20, prosody: 0.15, stability: 0.15 },
  prosody:      { gaze: 0.15, pacing: 0.25, prosody: 0.45, stability: 0.15 },
  spatial:      { gaze: 0.20, pacing: 0.10, prosody: 0.10, stability: 0.60 },
};

export function profileFor(drill) {
  if (!drill) return WEIGHT_PROFILES.default;
  if (drill.category === 'teleprompter') return WEIGHT_PROFILES.teleprompter;
  if (drill.category === 'prosody')      return WEIGHT_PROFILES.prosody;
  if (drill.category === 'spatial')      return WEIGHT_PROFILES.spatial;
  return WEIGHT_PROFILES.default;
}

export function components(t) {
  const gaze = bandOf('gaze_fixation_ratio', t.gaze_fixation_ratio);

  const pacing = Number.isFinite(t.wpm)
    ? Math.max(0, 1 - Math.abs(t.wpm - 140) / 40)
    : 0;

  // Prosody rewards melodic range and penalises uptalk on declaratives.
  const range = bandOf('pitch_semitone_sd', t.pitch_semitone_sd);
  const uptalk = Number.isFinite(t.terminal_pitch_slope) && t.terminal_pitch_slope > 0
    ? Math.min(1, t.terminal_pitch_slope / TARGETS.terminal_pitch_slope.tol)
    : 0;
  const prosody = Math.max(0, range * (1 - 0.5 * uptalk));

  // Stability blends gesture placement with physical composure.
  const plane = bandOf('truth_plane_occupancy', t.truth_plane_occupancy);
  const sway = Number.isFinite(t.torso_lateral_displacement_cm)
    ? Math.max(0, 1 - Math.max(0, t.torso_lateral_displacement_cm - TORSO_LIMIT_CM) / TORSO_LIMIT_CM)
    : 1;
  const stability = plane * sway;

  return { gaze, pacing, prosody, stability };
}

export function disfluencyPenalty(t) {
  if (!Number.isFinite(t.filler_density)) return 0;
  const over = t.filler_density - DISFLUENCY_THRESHOLD;
  if (over <= 0) return 0;
  return Math.min(0.30, over / TARGETS.filler_density.tol);
}

/** Composite score, 0..100, plus the breakdown VERA narrates from. */
export function score(telemetry, drill) {
  const w = profileFor(drill);
  const c = components(telemetry);
  const p = disfluencyPenalty(telemetry);
  const raw = w.gaze * c.gaze + w.pacing * c.pacing + w.prosody * c.prosody + w.stability * c.stability;
  return {
    score: Math.round(Math.max(0, Math.min(1, raw - p)) * 100),
    components: c,
    weights: w,
    penalty: p,
  };
}

/** Evaluate a drill's graduation predicate against a telemetry vector. */
export function meetsGraduation(drill, telemetry) {
  const g = drill.graduation || {};
  const checks = Object.entries(g).map(([metric, rule]) => {
    const v = telemetry[metric];
    if (!Number.isFinite(v)) return { metric, pass: false, reason: 'not measured' };
    let pass;
    switch (rule.op) {
      case '>=':      pass = v >= rule.value; break;
      case '<=':      pass = v <= rule.value; break;
      case '>':       pass = v >  rule.value; break;
      case '<':       pass = v <  rule.value; break;
      case '==':      pass = v === rule.value; break;
      case 'between': pass = v >= rule.value[0] && v <= rule.value[1]; break;
      default:        pass = false;
    }
    return { metric, pass, value: v, rule };
  });
  return { pass: checks.every(c => c.pass), checks };
}

/**
 * Stage graduation. The documents are explicit that benchmarks must hold across
 * three consecutive qualifying sessions, not one good take.
 */
export const REQUIRED_CONSECUTIVE = 3;

export function stageGraduated(stageDrills, sessions, required = REQUIRED_CONSECUTIVE) {
  const gated = stageDrills.filter(d => d.telemetry_gated);
  if (!gated.length) return true;
  let streak = 0;
  for (const s of sessions) {
    const all = gated.every(d => {
      const t = s.telemetry[d.id];
      return t && meetsGraduation(d, t).pass;
    });
    streak = all ? streak + 1 : 0;
    if (streak >= required) return true;
  }
  return false;
}
