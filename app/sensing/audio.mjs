/**
 * Acoustic pipeline: fundamental frequency, melodic range, terminal contour,
 * speaking rate, filler density, silence ratio.
 *
 * Runs entirely on-device. Nothing here returns audio — only numbers.
 */

/* ---------- YIN pitch detection ---------- */

const YIN_THRESHOLD = 0.12;

/**
 * YIN fundamental frequency estimate for one frame.
 * Returns Hz, or null when the frame is unvoiced or too noisy to trust.
 */
export function yinPitch(buf, sampleRate, threshold = YIN_THRESHOLD) {
  const halfLen = Math.floor(buf.length / 2);
  if (halfLen < 2) return null;

  // difference function
  const diff = new Float32Array(halfLen);
  for (let tau = 1; tau < halfLen; tau++) {
    let sum = 0;
    for (let i = 0; i < halfLen; i++) {
      const d = buf[i] - buf[i + tau];
      sum += d * d;
    }
    diff[tau] = sum;
  }

  // cumulative mean normalised difference
  const cmnd = new Float32Array(halfLen);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau < halfLen; tau++) {
    running += diff[tau];
    cmnd[tau] = running === 0 ? 1 : diff[tau] * tau / running;
  }

  // absolute threshold
  let tau = -1;
  for (let i = 2; i < halfLen; i++) {
    if (cmnd[i] < threshold) {
      while (i + 1 < halfLen && cmnd[i + 1] < cmnd[i]) i++;
      tau = i;
      break;
    }
  }
  if (tau === -1) return null;

  // parabolic interpolation around the minimum
  const x0 = tau > 1 ? tau - 1 : tau;
  const x2 = tau + 1 < halfLen ? tau + 1 : tau;
  let better = tau;
  if (x0 !== tau && x2 !== tau) {
    const s0 = cmnd[x0], s1 = cmnd[tau], s2 = cmnd[x2];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (denom !== 0) better = tau + (s2 - s0) / denom;
  }
  const hz = sampleRate / better;
  return hz >= 50 && hz <= 500 ? hz : null;   // plausible human speaking range
}

export const hzToSemitones = hz => 12 * Math.log2(hz / 55);

/** Melodic range: standard deviation of F0 expressed in semitones. */
export function pitchSemitoneSD(hzTrack) {
  const st = hzTrack.filter(Number.isFinite).map(hzToSemitones);
  if (st.length < 2) return null;
  const mean = st.reduce((a, b) => a + b, 0) / st.length;
  const varc = st.reduce((a, b) => a + (b - mean) ** 2, 0) / (st.length - 1);
  return Math.sqrt(varc);
}

/**
 * Terminal contour: mean semitone slope over the final window of an utterance.
 * Positive means the pitch rose into the period — uptalk on a declarative.
 */
export function terminalPitchSlope(hzTrack, frameMs = 20, windowMs = 500) {
  const n = Math.max(2, Math.round(windowMs / frameMs));
  const tail = hzTrack.slice(-n).filter(Number.isFinite);
  if (tail.length < 2) return null;
  const st = tail.map(hzToSemitones);
  // least-squares slope, semitones per window
  const xs = st.map((_, i) => i);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = st.reduce((a, b) => a + b, 0) / st.length;
  let num = 0, den = 0;
  for (let i = 0; i < st.length; i++) { num += (xs[i] - mx) * (st[i] - my); den += (xs[i] - mx) ** 2; }
  if (den === 0) return null;
  return (num / den) * st.length;
}

/* ---------- voice activity and pacing ---------- */

export function rms(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

/**
 * Silence ratio from a frame-level energy track. The documents distinguish
 * confident pauses from cognitive freezes, so pauses are also bucketed: a
 * pause under `freezeMs` is a beat, beyond it a stall.
 */
export function silenceProfile(energyTrack, frameMs, floor = 0.01, freezeMs = 2500) {
  if (!energyTrack.length) return { silence_ratio: null, pauses: [], freezes: 0 };
  const quiet = energyTrack.map(e => e < floor);
  const pauses = [];
  let run = 0;
  for (let i = 0; i < quiet.length; i++) {
    if (quiet[i]) run++;
    else if (run) { pauses.push(run * frameMs); run = 0; }
  }
  if (run) pauses.push(run * frameMs);
  return {
    silence_ratio: quiet.filter(Boolean).length / quiet.length,
    pauses,
    freezes: pauses.filter(p => p >= freezeMs).length,
  };
}

/**
 * Disfluency lexicon.
 *
 * 'right' is deliberately excluded. It is a real discourse marker, but "the
 * right call" / "turn right" / "that's right" are far more common, and the
 * graduation bars this metric feeds are 0.8% and 1.3% — tight enough that a
 * false positive rate of a few percent would fail speakers who were fluent.
 *
 * 'like' is retained because the source documents name it explicitly, but it
 * carries the same ambiguity ("felt like a fraud") and would need part-of-speech
 * tagging to disambiguate properly. Treat filler_density as having a small
 * positive bias for speakers who use simile heavily.
 */
export const FILLERS = ['um','uh','erm','ah','like','you know','i mean','sort of','basically','literally'];
export const HEDGES  = ['kind of','i guess','maybe','i think','i\'m no expert','not sure but','does that make sense','sort of','probably just'];

const words = text => (text.toLowerCase().match(/[a-z']+/g) || []);

/** Speaking rate from a transcript and its duration. */
export function wordsPerMinute(transcript, durationS) {
  if (!durationS) return null;
  return (words(transcript).length / durationS) * 60;
}

function phraseCount(text, phrases) {
  const t = ' ' + text.toLowerCase().replace(/[^a-z'\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
  let n = 0;
  for (const p of phrases) {
    const re = new RegExp(`\\s${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`, 'g');
    n += (t.match(re) || []).length;
  }
  return n;
}

/** Disfluency density as a fraction of total spoken words. */
export function fillerDensity(transcript) {
  const total = words(transcript).length;
  if (!total) return null;
  return phraseCount(transcript, FILLERS) / total;
}

/**
 * Hedge density. Distinct from filler density: fillers are a fluency artefact,
 * hedges are a conviction artefact, and a speaker can be fluent and still hedge
 * every claim.
 */
export function hedgeDensity(transcript) {
  const total = words(transcript).length;
  if (!total) return null;
  return phraseCount(transcript, HEDGES) / total;
}

export function apologyCount(transcript) {
  return phraseCount(transcript, ['sorry','my bad','excuse me','let me start again','can i redo that']);
}

/** Echo check for ABC bridging: did the speaker repeat the questioner's framing? */
export function negativeEchoes(transcript, loadedTerms) {
  return phraseCount(transcript, loadedTerms.map(t => t.toLowerCase()));
}
