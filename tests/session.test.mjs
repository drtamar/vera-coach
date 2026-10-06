import { readFileSync } from 'node:fs';
import { runnability, recordSession, recommend, stageProgress, emptyRecord,
         AUDIO_METRICS, BRACKET_S, TRANSCRIPT_METRICS, explainMissing, snapshotRun, restoreRun,
         RUN_MAX_AGE_MS } from '../app/coaching/session.mjs';
import { EfficacyModel } from '../app/learning/efficacy.mjs';
import { REQUIRED_CONSECUTIVE } from '../app/scoring/score.mjs';

const pass = [], fail = [];
const t = (n, c, extra='') => (c ? pass : fail).push(n + (c ? '' : `  ${extra}`));
const registry = JSON.parse(readFileSync(new URL('../registry/drills.json', import.meta.url)));
const byId = id => registry.drills.find(d => d.id === id);

/* ---------- runnability is reported, not hidden ---------- */
{
  // what the studio's measurePhase() actually returns
  const audioOnly = { produced: new Set(['wpm','filler_density','hedge_density',
    'pitch_semitone_sd','terminal_pitch_slope','silence_ratio','duration_s']) };
  t('runnability: an ungated drill always runs', runnability(byId('1.4'), { produced:new Set() }).runnable);
  t('runnability: an audio-gated drill runs with a mic', runnability(byId('3.3'), audioOnly).runnable);
  const gaze = runnability(byId('1.1'), audioOnly);
  t('runnability: a gaze-gated drill does not run without a camera', !gaze.runnable);
  t('runnability: and names what is missing', gaze.missing.includes('gaze_fixation_ratio'), JSON.stringify(gaze.missing));
  t('runnability: it runs once those metrics are produced',
    runnability(byId('1.1'), { produced:new Set(['gaze_fixation_ratio','blink_rate','head_yaw_deviation_deg']) }).runnable);
  const counts = registry.drills.map(d => runnability(d, audioOnly).runnable);
  t('runnability: 8 drills are genuinely runnable from what we measure',
    counts.filter(Boolean).length === 8, `${counts.filter(Boolean).length}`);
  // the bug this replaced: offered, but the benchmark was never computed
  t('runnability: a drill whose bar is never measured is NOT offered',
    !runnability(byId('1.3'), audioOnly).runnable, 'Yap Protocol needs speech_onset_latency_s');
  t('runnability: and names exactly which metric is missing',
    runnability(byId('1.3'), audioOnly).missing.includes('speech_onset_latency_s'));
}

/* ---------- graduation needs three CONSECUTIVE sessions ---------- */
{
  const drill = byId('3.3');   // silence_ratio between .15-.20, filler_density < .008
  const good = { silence_ratio: 0.17, filler_density: 0.004 };
  const bad  = { silence_ratio: 0.02, filler_density: 0.05 };
  const store = {};
  const r1 = recordSession(store, drill, { pre: good, post: good, at: 1 });
  t('graduation: one pass is not graduation', r1.passed && !r1.graduated && r1.streak === 1);
  recordSession(store, drill, { pre: good, post: good, at: 2 });
  const r3 = recordSession(store, drill, { pre: good, post: good, at: 3 });
  t('graduation: three consecutive passes graduate', r3.graduated && r3.streak === REQUIRED_CONSECUTIVE);
  t('graduation: the moment is marked once', r3.justGraduated);

  const s2 = {};
  recordSession(s2, drill, { pre: good, post: good, at: 1 });
  recordSession(s2, drill, { pre: good, post: good, at: 2 });
  const broken = recordSession(s2, drill, { pre: good, post: bad, at: 3 });
  t('graduation: a failure resets the streak to zero', !broken.passed && broken.streak === 0);
  const after = recordSession(s2, drill, { pre: good, post: good, at: 4 });
  t('graduation: and the count restarts from one', after.streak === 1);

  t('graduation: reps count every attempt, pass or fail', s2[drill.id].reps === 4);
  t('graduation: the failing check is reported', broken.checks.some(c => !c.pass));
}
{
  const drill = byId('1.4');   // ungated
  const store = {};
  const r = recordSession(store, drill, { pre: null, post: null, at: 1 });
  t('graduation: an ungated drill passes without telemetry', r.passed);
}

/* ---------- the efficacy observation is the point of the bracketing ---------- */
{
  const drill = byId('3.3');
  const eff = new EfficacyModel();
  const store = {};
  const r = recordSession(store, drill, {
    pre:  { silence_ratio: 0.02, filler_density: 0.06 },
    post: { silence_ratio: 0.17, filler_density: 0.004 },
    at: 1, efficacy: eff,
  });
  t('efficacy: a pre/post pair produces observations', r.learned && r.observations.length > 0);
  t('efficacy: improvement is positive when the metric moved toward target',
    r.observations.every(o => o.improvement > 0), JSON.stringify(r.observations));
  t('efficacy: the model actually received them', eff.effect(drill.id, 'filler_density').n > 0);

  const eff2 = new EfficacyModel();
  const r2 = recordSession({}, drill, { pre: null, post: { silence_ratio: 0.17, filler_density: 0.004 }, at: 1, efficacy: eff2 });
  t('efficacy: no baseline means nothing was learned, and it says so', !r2.learned && r2.observations.length === 0);
  t('efficacy: and the model was left untouched', eff2.effect(drill.id, 'filler_density').n === 0);
  t('efficacy: a session can still pass without a baseline', r2.passed);

  const eff3 = new EfficacyModel();
  const worse = recordSession({}, drill, {
    pre:  { silence_ratio: 0.17, filler_density: 0.004 },
    post: { silence_ratio: 0.02, filler_density: 0.06 },
    at: 1, efficacy: eff3,
  });
  t('efficacy: a drill that made things worse records a negative effect',
    worse.observations.some(o => o.improvement < 0));
}

/* ---------- recommendation ---------- */
{
  const caps = { produced: new Set(['wpm','filler_density','hedge_density','pitch_semitone_sd',
    'terminal_pitch_slope','silence_ratio','duration_s']) };
  const eff = new EfficacyModel();
  const r = recommend({ drills: registry.drills, store: {}, efficacy: eff, weakest: null, caps });
  t('recommend: with no evidence it follows the curriculum', r.why.includes('curriculum'));
  t('recommend: and only offers something runnable', runnability(r.drill, caps).runnable);
  t('recommend: starting at the lowest stage', r.drill.stage === 0, `stage ${r.drill.stage}`);

  const aimed = recommend({ drills: registry.drills, store: {}, efficacy: eff, weakest: 'filler_density', caps });
  t('recommend: a weak metric steers the choice', aimed.why.includes('filler_density'), aimed.why);
  t('recommend: to a drill that targets it', (aimed.drill.target_metrics||[]).includes('filler_density'));

  // everything graduated -> it still offers something rather than nothing
  const done = {};
  for (const d of registry.drills) done[d.id] = { ...emptyRecord(), streak: REQUIRED_CONSECUTIVE };
  const after = recommend({ drills: registry.drills, store: done, efficacy: eff, weakest: null, caps });
  t('recommend: still returns a drill once everything is graduated', after && after.drill);

  t('recommend: null when nothing is runnable',
    recommend({ drills: [byId('1.1')], store: {}, efficacy: eff, weakest: null, caps }) === null);
}

/* ---------- stage progress ---------- */
{
  const store = {};
  const p0 = stageProgress(registry.drills, store);
  t('stages: all six reported', p0.length === 6);
  t('stages: nothing done initially', p0.every(s => s.done === 0));
  for (const d of registry.drills.filter(x => x.stage === 0)) store[d.id] = { ...emptyRecord(), streak: 3 };
  const p1 = stageProgress(registry.drills, store);
  t('stages: completing a stage is reflected', p1[0].done === p1[0].total);
  t('stages: later stages untouched', p1[1].done === 0);
}

/* ---------- bookkeeping ---------- */
{
  const drill = byId('3.3'), store = {};
  for (let i = 0; i < 50; i++) recordSession(store, drill, { pre: null, post: { silence_ratio:0.17, filler_density:0.004 }, at: i });
  t('store: session history is bounded', store[drill.id].sessions.length <= 30, `${store[drill.id].sessions.length}`);
  t('store: but the rep count is not lost', store[drill.id].reps === 50);
}
/* ---------- why a drill is blocked is told truthfully ---------- */
{
  const w = explainMissing(['wpm', 'filler_density', 'speech_onset_latency_s', 'gaze_fixation_ratio']);
  t('explain: transcript metrics are attributed to speech recognition', w.transcript.join() === 'wpm,filler_density', JSON.stringify(w));
  t('explain: audio-derivable but uncomputed metrics are NOT blamed on the camera', w.unmeasured.join() === 'speech_onset_latency_s', JSON.stringify(w));
  t('explain: only genuinely visual metrics are blamed on the camera', w.camera.join() === 'gaze_fixation_ratio', JSON.stringify(w));
  t('explain: nothing missing explains nothing', explainMissing([]).camera.length === 0 && explainMissing().transcript.length === 0);
  // without Web Speech the transcript metrics vanish, and so do the drills that need them
  const noAsr = { produced: new Set(['pitch_semitone_sd','terminal_pitch_slope','silence_ratio','duration_s']) };
  const withAsr = { produced: new Set(['wpm','filler_density','hedge_density','pitch_semitone_sd','terminal_pitch_slope','silence_ratio','duration_s']) };
  const lost = registry.drills.filter(d => runnability(d, withAsr).runnable && !runnability(d, noAsr).runnable).map(d => d.id).sort();
  // 1.3 and 3.2 also check transcript metrics, but are already blocked by uncomputed ones — they were never runnable
  t('transcript: losing speech recognition removes exactly drills 3.3 and 3.4', lost.join() === '3.3,3.4', lost.join());
  t('transcript: the set matches what measurePhase derives from a transcript',
    [...TRANSCRIPT_METRICS].sort().join() === 'filler_density,hedge_density,wpm');
}

/* ---------- a reload does not discard the baseline ---------- */
{
  const d = byId('3.3'), now = 1_000_000_000_000;
  const pre = { silence_ratio: 0.1, wpm: 150 };
  const run = { drill: d, phase: 'baseline', pre, post: null };
  const snap = snapshotRun(run, now);
  t('snapshot: keeps the drill, the phase and the baseline', snap.drillId === '3.3' && snap.phase === 'baseline' && snap.pre.wpm === 150);
  t('snapshot: survives a JSON round trip (localStorage)', restoreRun(JSON.parse(JSON.stringify(snap)), registry.drills, { now })?.pre.wpm === 150);
  t('snapshot: a finished or absent run saves nothing', snapshotRun({ ...run, phase: 'done' }, now) === null && snapshotRun(null) === null);
  const back = restoreRun(snap, registry.drills, { now });
  t('restore: rebuilds the live drill object, not just its id', back.drill === d && back.phase === 'baseline' && back.post === null);
  t('restore: a snapshot older than the age limit is refused', restoreRun(snap, registry.drills, { now: now + RUN_MAX_AGE_MS + 1 }) === null);
  t('restore: a timestamp from the future is refused', restoreRun({ ...snap, at: now + 3_600_000 }, registry.drills, { now }) === null);
  t('restore: an unknown drill is refused', restoreRun({ ...snap, drillId: 'nope' }, registry.drills, { now }) === null);
  t('restore: a baseline phase with no baseline is corrupt', restoreRun({ ...snap, pre: null }, registry.drills, { now }) === null);
  t('restore: a phase that cannot be resumed is refused', restoreRun({ ...snap, phase: 'post' }, registry.drills, { now }) === null);
  t('restore: junk input is refused rather than thrown on', [null, undefined, 'x', 42, {}].every(x => restoreRun(x, registry.drills, { now }) === null));
  t('restore: a drill this device can no longer measure is refused',
    restoreRun(snap, registry.drills, { now, runnable: () => false }) === null);
  t('restore: an idle snapshot restores with no baseline', restoreRun({ drillId:'3.3', phase:'idle', pre:null, at: now }, registry.drills, { now }).pre === null);
}

t('constants: bracketing takes are short enough not to be a chore', BRACKET_S <= 30);
t('constants: audio metric set is non-trivial', AUDIO_METRICS.size > 10);

console.log(pass.map(s => '  PASS  ' + s).join('\n'));
if (fail.length) console.log('\n' + fail.map(s => '  FAIL  ' + s).join('\n'));
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
