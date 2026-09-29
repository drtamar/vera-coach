import {
  band, bandOf, improvement, score, components, disfluencyPenalty,
  meetsGraduation, stageGraduated, profileFor, TARGETS, WEIGHT_PROFILES,
} from '../app/scoring/score.mjs';
import { EfficacyModel, weakestMetric, MIN_TRIALS_TO_PRUNE } from '../app/learning/efficacy.mjs';
import { readFileSync } from 'node:fs';

const pass = [], fail = [];
const t = (n, c, extra='') => (c ? pass : fail).push(n + (c ? '' : `  ${extra}`));
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

/* seeded RNG so simulations are reproducible */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let x = Math.imul(a ^ a >>> 15, 1 | a);
    x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x;
    return ((x ^ x >>> 14) >>> 0) / 4294967296;
  };
}

/* ---------- band primitive ---------- */
t('band: inside range is full credit', band(0.7, [0.65, 0.85], 0.25) === 1);
t('band: at edge is full credit', band(0.65, [0.65, 0.85], 0.25) === 1);
t('band: decays linearly below', near(band(0.525, [0.65, 0.85], 0.25), 0.5));
t('band: decays linearly above', near(band(0.975, [0.65, 0.85], 0.25), 0.5));
t('band: floors at zero', band(0.1, [0.65, 0.85], 0.25) === 0);
t('band: NaN scores zero', band(NaN, [0, 1], 1) === 0);
t('bandOf: resolves named metric', bandOf('wpm', 140) === 1);

/* ---------- C_pacing, the one formula given explicitly ---------- */
const pacingAt = w => components({ wpm: w }).pacing;
t('C_pacing: 140 WPM is 1.0', pacingAt(140) === 1);
t('C_pacing: 160 WPM is 0.5 per spec', near(pacingAt(160), 0.5));
t('C_pacing: 120 WPM is 0.5 per spec', near(pacingAt(120), 0.5));
t('C_pacing: 180 WPM floors at 0', pacingAt(180) === 0);
t('C_pacing: 168 WPM matches worked example', near(pacingAt(168), 1 - 28/40));

/* ---------- prosody / uptalk ---------- */
t('prosody: monotone scores low', components({ pitch_semitone_sd: 1.0 }).prosody < 0.5);
t('prosody: in-band scores full', components({ pitch_semitone_sd: 3.0, terminal_pitch_slope: -1 }).prosody === 1);
t('prosody: uptalk penalises a good range',
  components({ pitch_semitone_sd: 3.0, terminal_pitch_slope: 1.0 }).prosody < 1);
t('prosody: downward terminal is not penalised',
  components({ pitch_semitone_sd: 3.0, terminal_pitch_slope: -2 }).prosody === 1);

/* ---------- disfluency penalty ---------- */
t('penalty: at threshold is zero', disfluencyPenalty({ filler_density: 0.013 }) === 0);
t('penalty: below threshold is zero', disfluencyPenalty({ filler_density: 0.005 }) === 0);
t('penalty: grows above threshold', disfluencyPenalty({ filler_density: 0.06 }) > 0);
t('penalty: is capped', disfluencyPenalty({ filler_density: 0.9 }) === 0.30);

/* ---------- composite, hand-computed ---------- */
{
  const tele = {
    gaze_fixation_ratio: 0.75, wpm: 140,
    pitch_semitone_sd: 3.0, terminal_pitch_slope: -1,
    truth_plane_occupancy: 0.5, torso_lateral_displacement_cm: 1.0,
    filler_density: 0.0,
  };
  const r = score(tele, { category: 'exposure' });
  t('composite: all components perfect scores 100', r.score === 100, `got ${r.score}`);
}
{
  // gaze .75 -> 1 ; wpm 160 -> .5 ; prosody 1 ; stability 1 ; no penalty
  // default weights: .25(1) + .25(.5) + .25(1) + .25(1) = 0.875 -> 88
  const r = score({
    gaze_fixation_ratio: 0.75, wpm: 160,
    pitch_semitone_sd: 3.0, terminal_pitch_slope: -1,
    truth_plane_occupancy: 0.5, torso_lateral_displacement_cm: 1.0,
    filler_density: 0.0,
  }, { category: 'exposure' });
  t('composite: hand-computed 0.875 -> 88', r.score === 88, `got ${r.score}`);
}

/* ---------- weight adaptation ---------- */
t('weights: teleprompter raises gaze to 0.50', profileFor({ category: 'teleprompter' }).gaze === 0.50);
t('weights: default is even quarters', profileFor({ category: 'exposure' }).gaze === 0.25);
for (const [name, p] of Object.entries(WEIGHT_PROFILES)) {
  t(`weights: ${name} profile sums to 1`, near(p.gaze + p.pacing + p.prosody + p.stability, 1));
}
{
  const tele = { gaze_fixation_ratio: 0.30, wpm: 140, pitch_semitone_sd: 3,
                 terminal_pitch_slope: -1, truth_plane_occupancy: 0.5,
                 torso_lateral_displacement_cm: 1, filler_density: 0 };
  const dflt = score(tele, { category: 'exposure' }).score;
  const tele2 = score(tele, { category: 'teleprompter' }).score;
  t('weights: poor gaze hurts more under teleprompter profile', tele2 < dflt, `${tele2} vs ${dflt}`);
}

/* ---------- improvement is scale-free ---------- */
{
  // wpm moving 20 toward band, band width 20 -> 1.0 band-widths
  t('improvement: wpm normalises by band width', near(improvement('wpm', 190, 170), 1.0));
  // gaze moving .10 toward band, width .20 -> 0.5
  t('improvement: gaze normalises by band width', near(improvement('gaze_fixation_ratio', 0.45, 0.55), 0.5));
  t('improvement: regression is negative', improvement('wpm', 150, 190) < 0);
  t('improvement: inside band to inside band is zero', improvement('wpm', 135, 145) === 0);
  t('improvement: unknown metric is zero', improvement('nope', 1, 2) === 0);
  // scale-free: comparable magnitudes across wildly different units
  const a = Math.abs(improvement('wpm', 190, 170));
  const b = Math.abs(improvement('gaze_fixation_ratio', 0.45, 0.65));
  t('improvement: comparable across units', Math.abs(a - b) < 0.01, `${a} vs ${b}`);
}

/* ---------- graduation predicates ---------- */
{
  const d = { graduation: {
    gaze_fixation_ratio: { op: '>=', value: 0.75 },
    blink_rate: { op: '<=', value: 24 },
    restarts: { op: '==', value: 0 },
    wpm: { op: 'between', value: [120, 155] },
  }};
  t('graduation: all pass', meetsGraduation(d, { gaze_fixation_ratio: .8, blink_rate: 20, restarts: 0, wpm: 140 }).pass);
  t('graduation: one fail blocks', !meetsGraduation(d, { gaze_fixation_ratio: .7, blink_rate: 20, restarts: 0, wpm: 140 }).pass);
  t('graduation: between is inclusive', meetsGraduation(d, { gaze_fixation_ratio: .8, blink_rate: 24, restarts: 0, wpm: 120 }).pass);
  t('graduation: missing metric fails rather than passing silently',
    !meetsGraduation(d, { gaze_fixation_ratio: .8, blink_rate: 20, restarts: 0 }).pass);
}

/* ---------- three-consecutive-session rule ---------- */
{
  const drills = [{ id: 'x', telemetry_gated: true, graduation: { wpm: { op: 'between', value: [130, 150] } } }];
  const ok = { telemetry: { x: { wpm: 140 } } };
  const bad = { telemetry: { x: { wpm: 200 } } };
  t('stage: two good sessions is not enough', !stageGraduated(drills, [ok, ok]));
  t('stage: three consecutive graduates', stageGraduated(drills, [ok, ok, ok]));
  t('stage: a failure resets the streak', !stageGraduated(drills, [ok, ok, bad, ok, ok]));
  t('stage: streak after a reset still counts', stageGraduated(drills, [ok, bad, ok, ok, ok]));
  t('stage: ungated stage passes trivially', stageGraduated([{ id: 'y', telemetry_gated: false }], []));
}

/* ---------- weakest metric ---------- */
{
  const w = weakestMetric({ wpm: 190, gaze_fixation_ratio: 0.64 }, TARGETS);
  t('weakest: picks the furthest from target in band-widths', w.metric === 'wpm', JSON.stringify(w));
  t('weakest: null when everything is in band',
    weakestMetric({ wpm: 140, gaze_fixation_ratio: 0.75 }, TARGETS) === null);
  const u = weakestMetric({ terminal_pitch_slope: 2.0 }, TARGETS);
  t('weakest: uptalk can register now the band is realistic', u && u.metric === 'terminal_pitch_slope', JSON.stringify(u));
}

/* ---------- efficacy: shrinkage and trust ---------- */
{
  const m = new EfficacyModel();
  m.record('d1', 'wpm', 190, 170);   // +1.0 band-width
  const e1 = m.effect('d1', 'wpm');
  t('shrinkage: one strong observation is pulled toward zero', e1.mean < 0.5, `${e1.mean}`);
  t('shrinkage: not yet trusted', !e1.trusted);
  for (let i = 0; i < 10; i++) m.record('d1', 'wpm', 190, 170);
  const e2 = m.effect('d1', 'wpm');
  t('shrinkage: estimate rises with evidence', e2.mean > e1.mean);
  t('shrinkage: converges toward the truth', e2.mean > 0.7, `${e2.mean}`);
  t('shrinkage: uncertainty shrinks with n', e2.sd < e1.sd);
  t('trust: clears the minimum trial bar', e2.trusted);
  t('persistence: round-trips through JSON', (() => {
    const r = new EfficacyModel(JSON.parse(JSON.stringify(m.toJSON())));
    return near(r.effect('d1', 'wpm').mean, e2.mean);
  })());
}

/* ---------- THE LEARNING CLAIM: does the bandit find the drill that works? ---------- */
{
  const rng = mulberry32(42);
  const drills = [
    { id: 'works',  source: 'generated', target_metrics: ['wpm'] },
    { id: 'inert1', source: 'generated', target_metrics: ['wpm'] },
    { id: 'inert2', source: 'generated', target_metrics: ['wpm'] },
  ];
  const TRUE_EFFECT = { works: 0.8, inert1: 0.0, inert2: 0.0 };
  const m = new EfficacyModel();
  const picks = [];

  for (let i = 0; i < 300; i++) {
    const chosen = m.select(drills, 'wpm', rng);
    picks.push(chosen.id);
    // simulate a within-session pre/post with noise around the true effect
    const noise = (rng() - 0.5) * 1.0;
    const gain = TRUE_EFFECT[chosen.id] + noise;      // in band-widths
    const before = 190;
    const after = before - gain * 20;                  // wpm band width is 20
    m.record(chosen.id, 'wpm', before, after);
  }

  const last100 = picks.slice(-100);
  const worksShare = last100.filter(p => p === 'works').length / 100;
  t('bandit: converges on the drill that actually works', worksShare > 0.6, `share=${worksShare}`);
  t('bandit: effective drill outranks inert ones',
    m.effect('works','wpm').mean > m.effect('inert1','wpm').mean &&
    m.effect('works','wpm').mean > m.effect('inert2','wpm').mean);
  t('bandit: still explored the alternatives', new Set(picks).size === 3);
}

/* ---------- pruning: retires what does not earn its place ---------- */
{
  const m = new EfficacyModel();
  const generated  = { id: 'gen', source: 'generated',  target_metrics: ['wpm'] };
  const researched = { id: 'res', source: 'researched', target_metrics: ['wpm'] };
  const documented = { id: 'doc', source: 'documented', target_metrics: ['wpm'] };
  const original   = { id: 'org', source: 'original',   target_metrics: ['wpm'] };
  for (const d of [generated, researched, documented, original]) {
    for (let i = 0; i < MIN_TRIALS_TO_PRUNE + 2; i++) m.record(d.id, 'wpm', 190, 192); // regression
  }
  const pruned = m.prune([generated, researched, documented, original]).map(p => p.id);
  t('prune: retires an inert generated drill', pruned.includes('gen'));
  t('prune: retires an inert researched drill', pruned.includes('res'));
  t('prune: never auto-retires documented curriculum', !pruned.includes('doc'));
  t('prune: never auto-retires original curriculum', !pruned.includes('org'));

  const m2 = new EfficacyModel();
  m2.record('gen', 'wpm', 190, 170);
  t('prune: spares a drill that has not had a fair trial', m2.prune([generated]).length === 0);

  const m3 = new EfficacyModel();
  for (let i = 0; i < MIN_TRIALS_TO_PRUNE + 2; i++) m3.record('gen', 'wpm', 190, 172);
  t('prune: keeps a generated drill that works', m3.prune([generated]).length === 0);
}

/* ---------- stall detection drives generation ---------- */
{
  const m = new EfficacyModel();
  const drills = [{ id: 'a', source: 'documented', target_metrics: ['wpm'] }];
  t('stall: unproven metric counts as stalled', m.stalled(drills, 'wpm'));
  for (let i = 0; i < 8; i++) m.record('a', 'wpm', 190, 172);
  t('stall: clears once something demonstrably works', !m.stalled(drills, 'wpm'));
  t('stall: a metric no drill targets is stalled', m.stalled(drills, 'blink_rate'));
}

/* ---------- registry integrity ---------- */
{
  const reg = JSON.parse(readFileSync(new URL('../registry/drills.json', import.meta.url)));
  const ids = reg.drills.map(d => d.id);
  t('registry: 21 drills', reg.drills.length === 21);
  t('registry: ids unique', new Set(ids).size === ids.length);
  t('registry: every stage 0-5 present', [0,1,2,3,4,5].every(s => reg.drills.some(d => d.stage === s)));
  t('registry: every target_metric is a defined metric',
    reg.drills.every(d => (d.target_metrics||[]).every(mm => mm in reg.metrics)));
  t('registry: every gated drill has graduation rules',
    reg.drills.filter(d => d.telemetry_gated).every(d => Object.keys(d.graduation||{}).length > 0));
  t('registry: every drill carries provenance',
    reg.drills.every(d => d.provenance && d.provenance.lineage && d.provenance.document));
  t('registry: every drill has coach_brief and protocol',
    reg.drills.every(d => d.coach_brief && Array.isArray(d.protocol) && d.protocol.length));
  t('registry: authored Stage 4-5 prompts are labelled as authored',
    reg.drills.filter(d => d.stage >= 4).every(d => d.coach_brief.startsWith('AUTHORED.')));
  t('registry: no Stage 0-3 drill is falsely labelled authored',
    reg.drills.filter(d => d.stage <= 3).every(d => !d.coach_brief.startsWith('AUTHORED.')));
  t('registry: source conflicts are documented where they exist',
    ['2.1','2.3','3.3'].every(id => reg.drills.find(d => d.id === id).notes?.length > 0));
  t('registry: graduation ops are all recognised',
    reg.drills.every(d => Object.values(d.graduation||{}).every(r => ['>=','<=','>','<','==','between'].includes(r.op))));
}

console.log(pass.map(s => '  PASS  ' + s).join('\n'));
if (fail.length) { console.log('\n' + fail.map(s => '  FAIL  ' + s).join('\n')); }
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
