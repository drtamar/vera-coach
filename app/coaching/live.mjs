/**
 * In-take coaching.
 *
 * The source material is emphatic about what live feedback must feel like —
 * "subtle, peripheral cues", "excessive live indicators during a take can
 * distract the user and increase anxiety" — and gives the cue vocabulary and a
 * couple of thresholds. It does not say how a threshold becomes a cue, and that
 * gap is where this either works or turns into nagging.
 *
 * Four mechanisms do the actual restraint:
 *
 *   SUSTAIN    A threshold crossed for one frame is noise, not a habit. A rule
 *              must hold its condition for its own sustain window before it is
 *              allowed to speak at all.
 *   HYSTERESIS Entering and leaving use different thresholds. Without that, a
 *              speaker sitting at exactly 165 WPM flickers in and out of the
 *              condition and the cue strobes.
 *   COOLDOWN   Per rule, and a global minimum gap between ANY two cues. Being
 *              told the same thing twice in five seconds reads as nagging;
 *              being told two different things at once reads as failure.
 *   BUDGET     A hard ceiling per minute across all rules. When several
 *              conditions are true at once, the speaker gets the one that
 *              matters most, not all of them.
 *
 * Plus a settling period: no cues at all for the first few seconds, because the
 * windows have not filled yet and being corrected before you have finished your
 * first sentence is the worst possible opening.
 *
 * Pure logic, time injected — no timers, no DOM. Testable without a browser.
 */

/** Cue vocabulary, exactly as the agent specification enumerates it. */
export const CUE_TYPES = ['pace_too_fast', 'hands_dropped', 'lens_contact_lost', 'uptalk_detected', 'excessive_sway'];
export const INTENSITIES = ['subtle_border_pulse', 'gentle_haptic', 'icon_flash'];

/**
 * Rules in priority order. Lower `priority` wins when several are ready.
 *
 * The ordering is a judgement about the moment, not about the metric: a speaker
 * who has stopped talking needs something different from one who is merely
 * fast, and being told to fix your hands while you are frozen is useless.
 */
export const CUE_RULES = [
  { id:'frozen', priority:1, metric:'silence_ms', sustainMs:0, cooldownMs:9000,
    enter:v => v > 2500, exit:v => v < 1200,
    intensity:'icon_flash', say:'Keep going.',
    why:'A pause past two and a half seconds has stopped being a beat and become a freeze.' },

  { id:'lens_contact_lost', priority:2, metric:'gaze_fixation_ratio', sustainMs:2500, cooldownMs:14000,
    enter:v => v < 0.45, exit:v => v > 0.60,
    intensity:'subtle_border_pulse', say:'Find the lens.',
    why:'Below 45% the eyes are scanning, which reads to a viewer as evasion.' },

  { id:'pace_too_fast', priority:3, metric:'wpm', sustainMs:4000, cooldownMs:16000,
    enter:v => v > 165, exit:v => v < 150,
    intensity:'subtle_border_pulse', say:'Slow down.',
    why:'Past 165 the nervous system is driving, and filler words follow the speed.' },

  { id:'hands_dropped', priority:4, metric:'hands_below_ms', sustainMs:0, cooldownMs:13000,
    enter:v => v > 3000, exit:v => v < 500,
    intensity:'icon_flash', say:'Hands up.',
    why:'Hands below the frame for three seconds reads as closed off.' },

  { id:'uptalk_detected', priority:5, metric:'terminal_pitch_slope', sustainMs:0, cooldownMs:22000,
    enter:v => v > 0.5, exit:v => v < 0,
    intensity:'icon_flash', say:'Land it.',
    why:'The sentence rose into the full stop, which sounds like asking permission.' },

  { id:'excessive_sway', priority:6, metric:'torso_lateral_displacement_cm', sustainMs:3000, cooldownMs:16000,
    enter:v => v > 2.0, exit:v => v < 1.4,
    intensity:'subtle_border_pulse', say:'Anchor your heels.',
    why:'The lens magnifies a sway that feels like nothing from the inside.' },

  { id:'pace_too_slow', priority:7, metric:'wpm', sustainMs:6000, cooldownMs:22000,
    enter:v => v < 105, exit:v => v > 120,
    intensity:'subtle_border_pulse', say:'Pick it up.',
    why:'Under 105 the delivery reads as a stall rather than deliberation.' },
];

export const DEFAULTS = {
  settleMs: 6000,       // silence for the opening — windows are not full and nobody wants correcting mid-first-sentence
  minGapMs: 7000,       // between any two cues, whatever their rule
  budgetPerMin: 4,      // hard ceiling across every rule
};

export class CueGovernor {
  constructor(opts = {}) {
    this.rules = (opts.rules || CUE_RULES).slice().sort((a, b) => a.priority - b.priority);
    this.cfg = { ...DEFAULTS, ...opts };
    this.reset();
  }

  reset(now = 0) {
    this.startedAt = now;
    this.lastCueAt = -Infinity;
    this.fires = [];                       // timestamps, for the per-minute budget
    this.st = new Map();                   // per-rule condition state
    for (const r of this.rules) this.st.set(r.id, { on:false, since:null, lastFired:-Infinity });
  }

  /** Cues fired in the last minute. Exposed so a UI can show the budget honestly. */
  spentThisMinute(now) {
    return this.fires.filter(t => now - t < 60000).length;
  }

  /**
   * Advance the state machine one frame and return a cue, or null.
   *
   * Always called, every frame — the condition tracking has to run even while
   * the governor is refusing to speak, or sustain windows never accumulate.
   */
  tick(metrics, now) {
    const ready = [];

    for (const r of this.rules) {
      const v = metrics?.[r.metric];
      const s = this.st.get(r.id);

      if (!Number.isFinite(v)) { s.on = false; s.since = null; continue; }

      // hysteresis: leaving takes a different threshold than entering
      if (!s.on && r.enter(v)) { s.on = true; s.since = now; }
      else if (s.on && r.exit(v)) { s.on = false; s.since = null; }

      if (!s.on || s.since === null) continue;
      if (now - s.since < r.sustainMs) continue;          // not yet a habit
      if (now - s.lastFired < r.cooldownMs) continue;     // said recently
      ready.push(r);
    }

    if (!ready.length) return null;
    if (now - this.startedAt < this.cfg.settleMs) return null;
    if (now - this.lastCueAt < this.cfg.minGapMs) return null;
    if (this.spentThisMinute(now) >= this.cfg.budgetPerMin) return null;

    // several true at once: the speaker gets one, the one that matters most
    const r = ready[0];
    this.st.get(r.id).lastFired = now;
    this.lastCueAt = now;
    this.fires.push(now);

    return {
      id: r.id, cue_type: r.id, intensity: r.intensity, say: r.say, why: r.why,
      priority: r.priority, at: now,
      suppressed: ready.slice(1).map(x => x.id),   // what was true but not shown
    };
  }
}

/**
 * Windowed telemetry for the live loop.
 *
 * Post-take metrics average the whole take, which is exactly wrong in the
 * moment: a speaker who opens at 120 and accelerates to 190 still shows a
 * cumulative 150 and never gets told. Live pace has to be the recent past.
 */
export class RollingTelemetry {
  constructor({ windowMs = 12000 } = {}) {
    this.windowMs = windowMs;
    this.frames = [];     // {at, rms, hz}
    this.words = [];      // {at, n}
  }

  pushAudio(at, rms, hz) {
    this.frames.push({ at, rms, hz: Number.isFinite(hz) ? hz : null });
    this._trim(at);
  }

  pushWords(at, n) {
    this.words.push({ at, n });
    this._trim(at);
  }

  _trim(now) {
    const cut = now - this.windowMs;
    while (this.frames.length && this.frames[0].at < cut) this.frames.shift();
    while (this.words.length && this.words[0].at < cut) this.words.shift();
  }

  /** Current trailing silence, in ms — a beat becoming a freeze. */
  silenceMs(now, floor = 0.01) {
    let ms = 0;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i].rms >= floor) break;
      ms = now - this.frames[i].at;
    }
    return ms;
  }

  metrics(now) {
    const span = Math.min(this.windowMs, now - (this.frames[0]?.at ?? now)) / 1000;
    const words = this.words.reduce((a, w) => a + w.n, 0);
    const hz = this.frames.map(f => f.hz).filter(Number.isFinite);

    return {
      wpm: span >= 3 && words > 0 ? (words / span) * 60 : null,
      silence_ms: this.silenceMs(now),
      pitch_semitone_sd: hz.length > 8 ? sd(hz.map(semitones)) : null,
      terminal_pitch_slope: hz.length > 8 ? slope(hz.slice(-25).map(semitones)) : null,
      window_s: span,
    };
  }
}

const semitones = hz => 12 * Math.log2(hz / 55);
function sd(xs) {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
function slope(ys) {
  if (ys.length < 2) return null;
  const n = ys.length, mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - mx) * (ys[i] - my); den += (i - mx) ** 2; }
  return den ? (num / den) * n : null;
}
