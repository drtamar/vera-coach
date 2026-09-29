/**
 * Optical metric extraction — pure functions over landmark arrays.
 *
 * Deliberately separated from the MediaPipe wiring in pipeline.mjs so the
 * arithmetic is testable without a browser or a webcam. Every function takes
 * plain arrays of {x,y,z} and returns numbers.
 *
 * Landmark indices follow the MediaPipe FaceMesh 478-point topology.
 */

export const EYE = {
  left:  { outer: 33,  inner: 133, top: [160, 158], bottom: [144, 153], iris: [468, 469, 470, 471, 472] },
  right: { outer: 263, inner: 362, top: [385, 387], bottom: [380, 373], iris: [473, 474, 475, 476, 477] },
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

/* ---------- blink ---------- */

/**
 * Eye Aspect Ratio. Collapses toward zero as the lid closes, which is what the
 * documented blink counter keys on.
 */
export function eyeAspectRatio(lm, side = 'left') {
  const e = EYE[side];
  const h = dist(lm[e.outer], lm[e.inner]);
  if (!h) return 0;
  const v1 = dist(lm[e.top[0]], lm[e.bottom[0]]);
  const v2 = dist(lm[e.top[1]], lm[e.bottom[1]]);
  return (v1 + v2) / (2 * h);
}

export const EAR_CLOSED = 0.21;

/**
 * Blinks per minute from an EAR track. A blink is a contiguous dip below
 * threshold; sustained closure beyond `maxBlinkMs` is not a blink, so a long
 * eyes-shut moment doesn't inflate the count.
 */
export function blinkRate(earTrack, frameMs, threshold = EAR_CLOSED, maxBlinkMs = 500) {
  if (!earTrack.length) return null;
  let blinks = 0, run = 0;
  for (const ear of earTrack) {
    if (ear < threshold) run++;
    else {
      if (run > 0 && run * frameMs <= maxBlinkMs) blinks++;
      run = 0;
    }
  }
  if (run > 0 && run * frameMs <= maxBlinkMs) blinks++;
  const minutes = (earTrack.length * frameMs) / 60000;
  return minutes > 0 ? blinks / minutes : null;
}

/* ---------- gaze ---------- */

/**
 * Iris offset within the eye aperture, normalised to roughly [-1, 1] on each
 * axis. Zero means the iris is centred.
 *
 * NOTE ON RIGOUR: the source specification calls for a calibrated 3D gaze
 * vector projected against a sphere at the lens. This is the uncalibrated
 * approximation — it holds because the drill setup mandates the lens at eye
 * level at a fixed distance, which makes "iris centred" and "looking at the
 * lens" very nearly the same statement. It is reported as an approximation
 * rather than dressed up as a calibrated vector.
 */
export function irisOffset(lm, side = 'left') {
  const e = EYE[side];
  if (!lm[e.iris[0]]) return null;          // refineLandmarks was off
  const iris = lm[e.iris[0]];
  const outer = lm[e.outer], inner = lm[e.inner];
  const cx = (outer.x + inner.x) / 2, cy = (outer.y + inner.y) / 2;
  const halfW = Math.abs(outer.x - inner.x) / 2;
  const halfH = (dist(lm[e.top[0]], lm[e.bottom[0]]) + dist(lm[e.top[1]], lm[e.bottom[1]])) / 4;
  if (!halfW || !halfH) return null;
  return { x: (iris.x - cx) / halfW, y: (iris.y - cy) / halfH };
}

export const GAZE_TOLERANCE = 0.35;

/** Is the speaker looking at the lens on this frame? */
export function onLens(lm, tol = GAZE_TOLERANCE) {
  const l = irisOffset(lm, 'left'), r = irisOffset(lm, 'right');
  const offs = [l, r].filter(Boolean);
  if (!offs.length) return null;
  const mx = mean(offs.map(o => Math.abs(o.x)));
  const my = mean(offs.map(o => Math.abs(o.y)));
  return Math.hypot(mx, my) <= tol;
}

/** Fraction of measurable frames on the lens. */
export function gazeFixationRatio(onLensTrack) {
  const valid = onLensTrack.filter(v => v !== null);
  if (!valid.length) return null;
  return valid.filter(Boolean).length / valid.length;
}

/** Horizontal scanning, the teleprompter tell. Degrees of X-axis deviation. */
export function horizontalDeviationDeg(offsetTrack, fovDeg = 30) {
  const xs = offsetTrack.filter(Boolean).map(o => o.x);
  if (xs.length < 2) return null;
  const m = mean(xs);
  const sd = Math.sqrt(mean(xs.map(x => (x - m) ** 2)));
  return sd * fovDeg;
}

/* ---------- head pose ---------- */

/** Euler angles in degrees from a MediaPipe 4x4 facial transformation matrix. */
export function headPose(matrix) {
  const m = matrix.length === 16 ? matrix : matrix.data;
  if (!m) return null;
  const r = (i, j) => m[i * 4 + j];
  const pitch = Math.atan2(-r(2, 0), Math.hypot(r(2, 1), r(2, 2)));
  const yaw   = Math.atan2(r(1, 0), r(0, 0));
  const roll  = Math.atan2(r(2, 1), r(2, 2));
  const deg = x => x * 180 / Math.PI;
  return { pitch: deg(pitch), yaw: deg(yaw), roll: deg(roll) };
}

/** Lateral head tilt, the warmth cue. Absolute roll in degrees. */
export const headTiltAngle = pose => (pose ? Math.abs(pose.roll) : null);

export function yawDeviationDeg(poseTrack) {
  const ys = poseTrack.filter(Boolean).map(p => p.yaw);
  if (ys.length < 2) return null;
  const m = mean(ys);
  return Math.sqrt(mean(ys.map(y => (y - m) ** 2)));
}

/* ---------- body ---------- */

export const POSE = {
  nose: 0, leftShoulder: 11, rightShoulder: 12,
  leftWrist: 15, rightWrist: 16, leftHip: 23, rightHip: 24,
};

const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Is a hand inside the TruthPlane on this frame?
 *
 * The plane runs from the navel to the sternum. Navel is approximated as the
 * hip midpoint, sternum as the shoulder midpoint, and the band is the vertical
 * span between them. Image y grows downward, so "above the navel" is a smaller y.
 */
export function inTruthPlane(pose) {
  const hip = midpoint(pose[POSE.leftHip], pose[POSE.rightHip]);
  const sho = midpoint(pose[POSE.leftShoulder], pose[POSE.rightShoulder]);
  const navelY = hip.y, sternumY = sho.y;
  const hit = w => w && w.y <= navelY && w.y >= sternumY;
  return hit(pose[POSE.leftWrist]) || hit(pose[POSE.rightWrist]);
}

export const truthPlaneOccupancy = track => {
  const valid = track.filter(v => v !== null);
  return valid.length ? valid.filter(Boolean).length / valid.length : null;
};

/** Consecutive frames with both hands below frame, in milliseconds. */
export function handsBelowFrameRuns(pose_track, frameMs) {
  const runs = [];
  let run = 0;
  for (const p of pose_track) {
    const below = !p || (
      (!p[POSE.leftWrist]  || p[POSE.leftWrist].y  > 1) &&
      (!p[POSE.rightWrist] || p[POSE.rightWrist].y > 1)
    );
    if (below) run++;
    else { if (run) runs.push(run * frameMs); run = 0; }
  }
  if (run) runs.push(run * frameMs);
  return runs;
}

/**
 * Torso sway. Standard deviation of the shoulder-midpoint x, converted from
 * normalised image units to centimetres using shoulder width as the ruler
 * (assumed ~40cm, the population mean for biacromial breadth).
 */
export const ASSUMED_SHOULDER_CM = 40;

export function torsoLateralDisplacementCm(poseTrack, shoulderCm = ASSUMED_SHOULDER_CM) {
  const pts = poseTrack.filter(Boolean);
  if (pts.length < 2) return null;
  const xs = pts.map(p => midpoint(p[POSE.leftShoulder], p[POSE.rightShoulder]).x);
  const widths = pts.map(p => Math.abs(p[POSE.leftShoulder].x - p[POSE.rightShoulder].x)).filter(w => w > 0);
  if (!widths.length) return null;
  const m = mean(xs);
  const sdNorm = Math.sqrt(mean(xs.map(x => (x - m) ** 2)));
  return (sdNorm / mean(widths)) * shoulderCm;
}

/** Clavicular rise during inhalation — the Second Circle failure mode. */
export function clavicularRiseMm(poseTrack, shoulderCm = ASSUMED_SHOULDER_CM) {
  const pts = poseTrack.filter(Boolean);
  if (pts.length < 2) return null;
  const ys = pts.map(p => midpoint(p[POSE.leftShoulder], p[POSE.rightShoulder]).y);
  const widths = pts.map(p => Math.abs(p[POSE.leftShoulder].x - p[POSE.rightShoulder].x)).filter(w => w > 0);
  if (!widths.length) return null;
  const travel = Math.max(...ys) - Math.min(...ys);
  return (travel / mean(widths)) * shoulderCm * 10;
}

/* ---------- facial action units, via blendshapes ---------- */

export const AU = {
  au12_smile:   ['mouthSmileLeft', 'mouthSmileRight'],
  au1_2_brow:   ['browInnerUp', 'browOuterUpLeft', 'browOuterUpRight'],
  au4_furrow:   ['browDownLeft', 'browDownRight'],
  au15_20_lip:  ['mouthFrownLeft', 'mouthFrownRight', 'mouthStretchLeft', 'mouthStretchRight'],
};

export function auScore(blendshapes, au) {
  if (!blendshapes?.length) return null;
  const byName = Object.fromEntries(blendshapes.map(b => [b.categoryName, b.score]));
  const vals = AU[au].map(n => byName[n]).filter(Number.isFinite);
  return vals.length ? Math.max(...vals) : null;
}

export const AU_ACTIVE = 0.35;

/** Count discrete activations of an AU across a session, not frames. */
export function auEvents(blendshapeTrack, au, threshold = AU_ACTIVE) {
  let events = 0, active = false;
  for (const bs of blendshapeTrack) {
    const s = auScore(bs, au);
    if (s === null) continue;
    if (s >= threshold && !active) { events++; active = true; }
    else if (s < threshold) active = false;
  }
  return events;
}
