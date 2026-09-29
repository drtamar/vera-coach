import { CueGovernor, RollingTelemetry, CUE_RULES, CUE_TYPES, INTENSITIES, DEFAULTS } from '../app/coaching/live.mjs';

const pass = [], fail = [];
const t = (n, c, extra='') => (c ? pass : fail).push(n + (c ? '' : `  ${extra}`));

/** Drive the governor for `ms` at 100ms frames, holding metrics constant. */
function run(gov, metrics, ms, from = 0, step = 100) {
  const cues = [];
  for (let n = from; n <= from + ms; n += step) {
    const m = typeof metrics === 'function' ? metrics(n) : metrics;
    const c = gov.tick(m, n);
    if (c) cues.push(c);
  }
  return cues;
}
const fresh = (opts = {}) => { const g = new CueGovernor(opts); g.reset(0); return g; };

/* ---------- vocabulary matches the specification ---------- */
t('rules: every documented cue type is implemented',
  CUE_TYPES.every(c => CUE_RULES.some(r => r.id === c)),
  CUE_TYPES.filter(c => !CUE_RULES.some(r => r.id === c)).join(','));
t('rules: every intensity is one the spec enumerates',
  CUE_RULES.every(r => INTENSITIES.includes(r.intensity)));
t('rules: priorities are unique', new Set(CUE_RULES.map(r => r.priority)).size === CUE_RULES.length);
t('rules: every rule carries words to say', CUE_RULES.every(r => r.say && r.say.length < 30));
t('rules: in-take language stays terse, as the manual requires',
  CUE_RULES.every(r => r.say.split(/\s+/).length <= 4), CUE_RULES.find(r=>r.say.split(/\s+/).length>4)?.say);
t('rules: the documented 165 WPM threshold is honoured',
  CUE_RULES.find(r => r.id === 'pace_too_fast').enter(166) && !CUE_RULES.find(r => r.id === 'pace_too_fast').enter(164));

/* ---------- the settling period ---------- */
{
  const g = fresh();
  const early = run(g, { wpm: 200 }, DEFAULTS.settleMs - 500);
  t('settle: nothing fires during the opening seconds', early.length === 0, `${early.length} cues`);
  const later = run(g, { wpm: 200 }, 6000, DEFAULTS.settleMs);
  t('settle: it fires once the opening has passed', later.length > 0);
}

/* ---------- sustain ---------- */
{
  const g = fresh();
  // fast for only 2s, then fine — under the 4s sustain window
  const cues = run(g, n => ({ wpm: (n >= 8000 && n < 10000) ? 200 : 140 }), 20000);
  t('sustain: a two-second spike is not a cue', cues.length === 0, cues.map(c=>c.id).join(','));

  const g2 = fresh();
  const held = run(g2, n => ({ wpm: n >= 8000 ? 200 : 140 }), 20000);
  t('sustain: a sustained overspeed is', held.some(c => c.id === 'pace_too_fast'));
  const first = held.find(c => c.id === 'pace_too_fast');
  t('sustain: and only after the window elapses', first.at >= 8000 + 4000, `fired at ${first.at}`);
}

/* ---------- hysteresis ---------- */
{
  const r = CUE_RULES.find(x => x.id === 'pace_too_fast');
  t('hysteresis: exit threshold sits below the entry one', r.exit(149) && !r.exit(160));

  // A speaker oscillating 160/170 is genuinely too fast. With a SINGLE threshold
  // the condition flips off on every dip, `since` resets, the sustain window
  // never completes — and they are never told. That is the failure hysteresis
  // exists to prevent, and it is a missed cue, not a strobe.
  const wobble = n => ({ wpm: 160 + (Math.floor(n / 200) % 2) * 10 });

  const single = fresh({ rules: [{ ...r, exit: v => !r.enter(v) }] });
  t('hysteresis: a single-threshold rule misses an oscillating speaker entirely',
    run(single, wobble, 60000).length === 0);

  const withHyst = fresh();
  const cues = run(withHyst, wobble, 60000);
  t('hysteresis: the real rule catches them', cues.length > 0);
  // and cooldown, not frame rate, governs how often
  const gaps = cues.slice(1).map((c, i) => c.at - cues[i].at);
  t('hysteresis: repeats are spaced by cooldown, not by frame',
    gaps.every(x => x >= r.cooldownMs), `gaps ${gaps.join(',')}`);
  t('hysteresis: and stay within the budget', cues.length <= DEFAULTS.budgetPerMin, `${cues.length}`);
}

/* ---------- cooldown and global gap ---------- */
{
  const g = fresh({ budgetPerMin: 99 });
  const cues = run(g, { wpm: 200 }, 60000);
  const gaps = cues.slice(1).map((c, i) => c.at - cues[i].at);
  t('cooldown: the same cue does not repeat inside its own cooldown',
    gaps.every(x => x >= CUE_RULES.find(r=>r.id==='pace_too_fast').cooldownMs), `gaps ${gaps.join(',')}`);
}
{
  // two conditions true at once, both otherwise eligible
  const g = fresh({ budgetPerMin: 99 });
  const cues = run(g, { wpm: 200, silence_ms: 3000 }, 12000);
  const gaps = cues.slice(1).map((c, i) => c.at - cues[i].at);
  t('gap: no two cues land closer than the global minimum',
    gaps.every(x => x >= DEFAULTS.minGapMs), `gaps ${gaps.join(',')}`);
}

/* ---------- budget ---------- */
{
  const g = fresh({ minGapMs: 0 });
  // everything wrong at once, for a full minute
  const cues = run(g, { wpm: 200, silence_ms: 3000, gaze_fixation_ratio: 0.2,
                        hands_below_ms: 4000, terminal_pitch_slope: 1.2,
                        torso_lateral_displacement_cm: 3 }, 60000);
  t('budget: a minute is capped however much is wrong',
    cues.length <= DEFAULTS.budgetPerMin, `${cues.length} cues in 60s`);
  t('budget: it still says something rather than going silent', cues.length > 0);
}

/* ---------- priority ---------- */
{
  const g = fresh();
  const cues = run(g, { silence_ms: 3000, wpm: 200, torso_lateral_displacement_cm: 3 }, 9000);
  t('priority: a freeze outranks pace and sway', cues[0]?.id === 'frozen', cues[0]?.id);
  t('priority: what was suppressed is reported, not lost',
    cues[0]?.suppressed.includes('pace_too_fast'), JSON.stringify(cues[0]?.suppressed));
}
{
  const g = fresh();
  const cues = run(g, { gaze_fixation_ratio: 0.2, torso_lateral_displacement_cm: 3 }, 12000);
  t('priority: losing the lens outranks swaying', cues[0]?.id === 'lens_contact_lost', cues[0]?.id);
}

/* ---------- absent metrics ---------- */
{
  const g = fresh();
  // no vision at all — the artifact case
  const cues = run(g, { wpm: 140, silence_ms: 0 }, 60000);
  t('absent: vision-only rules never fire without vision data', cues.length === 0);
  const g2 = fresh();
  const cues2 = run(g2, { wpm: null, gaze_fixation_ratio: undefined, silence_ms: 3000 }, 12000);
  t('absent: null and undefined are ignored, not treated as zero',
    cues2.every(c => c.id === 'frozen'), cues2.map(c=>c.id).join(','));
}

/* ---------- reset between takes ---------- */
{
  const g = fresh();
  run(g, { wpm: 200 }, 30000);
  g.reset(100000);
  const after = run(g, { wpm: 200 }, DEFAULTS.settleMs - 500, 100000);
  t('reset: a new take gets its own settling period', after.length === 0);
  t('reset: the budget is cleared', g.spentThisMinute(100000) === 0);
}

/* ---------- rolling telemetry ---------- */
{
  const r = new RollingTelemetry({ windowMs: 10000 });
  for (let n = 0; n <= 10000; n += 100) r.pushAudio(n, 0.2, 200);
  // 30 words over the last 10s = 180 wpm
  for (let n = 0; n <= 10000; n += 1000) r.pushWords(n, 3);
  const m = r.metrics(10000);
  t('rolling: wpm computed over the window', Math.abs(m.wpm - 198) < 40, `${m.wpm}`);
  t('rolling: pitch sd available with enough frames', Number.isFinite(m.pitch_semitone_sd));

  // the case post-take metrics hide: slow open, fast finish
  const r2 = new RollingTelemetry({ windowMs: 10000 });
  for (let n = 0; n <= 60000; n += 100) r2.pushAudio(n, 0.2, 200);
  for (let n = 0; n < 30000; n += 1000) r2.pushWords(n, 2);       // 120 wpm early
  for (let n = 30000; n <= 60000; n += 1000) r2.pushWords(n, 3.5); // 210 wpm late
  const late = r2.metrics(60000);
  t('rolling: a mid-take acceleration is visible, where a cumulative average hides it',
    late.wpm > 180, `${late.wpm}`);

  const r3 = new RollingTelemetry({ windowMs: 10000 });
  for (let n = 0; n <= 5000; n += 100) r3.pushAudio(n, 0.0005, null);
  t('rolling: trailing silence measured', r3.silenceMs(5000) > 4000, `${r3.silenceMs(5000)}`);
  t('rolling: window trims old frames', (() => {
    const q = new RollingTelemetry({ windowMs: 2000 });
    for (let n = 0; n <= 10000; n += 100) q.pushAudio(n, 0.2, 200);
    return q.frames.length <= 22;
  })());
  t('rolling: too little data reports null rather than a wild number',
    new RollingTelemetry().metrics(0).wpm === null);
}

console.log(pass.map(s => '  PASS  ' + s).join('\n'));
if (fail.length) console.log('\n' + fail.map(s => '  FAIL  ' + s).join('\n'));
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
