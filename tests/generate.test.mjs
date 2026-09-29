import { readFileSync } from 'node:fs';
import { buildPrompt, drillSchema, generateDrill, generateIfStalled, PROMPT_VERSION } from '../server/generate.mjs';
import { askForJSON, withRetry, LLMRefused, LLMMalformed, LLMUnavailable, DEFAULT_MODEL } from '../server/llm.mjs';
import { EfficacyModel } from '../app/learning/efficacy.mjs';
import { validateProposedDrill } from '../server/tools.mjs';

const pass = [], fail = [];
const t = (n, c, extra='') => (c ? pass : fail).push(n + (c ? '' : `  ${extra}`));

const registry = JSON.parse(readFileSync(new URL('../registry/drills.json', import.meta.url)));
const METRICS = Object.keys(registry.metrics);

/* ---------- fakes ---------- */
const seen = [];
function fakeClient(...replies) {
  let i = 0;
  return { messages: { create: async req => {
    seen.push(req);
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r(req);
    return r;
  }}};
}
const reply = (obj, over = {}) => ({
  stop_reason: 'end_turn', model: 'claude-opus-5-5',
  usage: { input_tokens: 10, output_tokens: 20 },
  content: [{ type: 'text', text: JSON.stringify(obj) }],
  ...over,
});

const GOOD = {
  name: 'Peripheral Anchor Hold',
  target_metrics: ['gaze_fixation_ratio'],
  graduation: [{ metric: 'gaze_fixation_ratio', op: '>=', value: 0.75 }],
  duration_s: 120,
  coach_brief: 'Your eyes leave the lens whenever you reach for a word. We are going to decouple those two things.',
  protocol: ['Place a dot above the lens.', 'Speak for two minutes, returning to the dot on every full stop.'],
  intervention_cues: [{ trigger: 'gaze_drifts_on_pause', say: 'Stay on the dot while you think.' }],
  rationale: 'Separates word retrieval from gaze by giving the eyes a fixed home.',
};

/* ---------- schema ---------- */
{
  const s = drillSchema(METRICS);
  t('schema: is a strict object', s.type === 'object' && s.additionalProperties === false);
  t('schema: constrains target_metrics to known metrics',
    JSON.stringify(s.properties.target_metrics.items.enum) === JSON.stringify(METRICS));
  t('schema: graduation ops are enumerated',
    s.properties.graduation.items.properties.op.enum.includes('between'));
  t('schema: graduation value accepts a number or a range',
    s.properties.graduation.items.properties.value.anyOf.length === 2);
  t('schema: duration is bounded',
    s.properties.duration_s.minimum === 30 && s.properties.duration_s.maximum === 900);
  t('schema: requires a rationale', s.required.includes('rationale'));
}

/* ---------- prompt ---------- */
{
  const p = buildPrompt({
    metric: 'wpm',
    registryMetrics: registry.metrics,
    tried: [
      { name: 'Pasta-Sauce Reduction', mechanism: 'boil the message down', effect: 0.02, n: 7 },
      { name: 'Melodic Staircase', mechanism: 'pitch staircase', effect: -0.30, n: 5 },
    ],
    telemetry: { wpm: 188 },
  });
  t('prompt: names the stalled metric', p.includes('STALLED METRIC: wpm'));
  t('prompt: states the target band', p.includes('130 to 150'));
  t('prompt: states the current measurement', p.includes('188'));
  t('prompt: lists what was already tried', p.includes('Pasta-Sauce Reduction'));
  t('prompt: reports measured effect, not just names', p.includes('0.02') && p.includes('-0.30'));
  t('prompt: labels a negative effect as having made it worse', p.includes('made it worse'));
  t('prompt: labels a null effect honestly', p.includes('no measurable effect'));
  t('prompt: forbids reinventing a failed drill', p.toLowerCase().includes('different mechanism'));
  t('prompt: enumerates available telemetry', METRICS.every(m => p.includes(m)));
  const bare = buildPrompt({ metric: 'wpm', registryMetrics: registry.metrics, tried: [], telemetry: {} });
  t('prompt: omits the tried section when nothing has been tried', !bare.includes('ALREADY TRIED'));
}

/* ---------- request shape ---------- */
{
  seen.length = 0;
  await generateDrill({ metric: 'gaze_fixation_ratio', registry, efficacy: new EfficacyModel(), client: fakeClient(reply(GOOD)) });
  const req = seen[0];
  t('request: uses the default model', req.model === DEFAULT_MODEL, req.model);
  t('request: adaptive thinking', req.thinking?.type === 'adaptive');
  t('request: effort set explicitly (Opus 5.5 defaults to medium)', req.output_config?.effort === 'high');
  t('request: structured output via json_schema', req.output_config?.format?.type === 'json_schema');
  t('request: no forced tool_choice (400s on this model family)', req.tool_choice === undefined);
  t('request: no tools array', req.tools === undefined);
  t('request: system prompt carries the coaching philosophy', req.system.includes('confidant'));
  t('request: system prompt forbids inventing measurements', req.system.includes('Do not invent a measurement'));
  t('request: max_tokens is generous', req.max_tokens >= 8000);
}

/* ---------- happy path ---------- */
{
  const r = await generateDrill({ metric: 'gaze_fixation_ratio', registry, efficacy: new EfficacyModel(), client: fakeClient(reply(GOOD)) });
  t('generate: succeeds on a valid reply', r.ok, JSON.stringify(r.errors));
  const d = r.drill;
  t('generate: marked as generated', d.source === 'generated');
  t('generate: graduation converted to object form', d.graduation.gaze_fixation_ratio?.op === '>=');
  t('generate: id is unique and namespaced', d.id.startsWith('gen.gaze_fixation_ratio.'));
  t('generate: records the prompt version', d.provenance.document.includes(PROMPT_VERSION));
  t('generate: records the serving model', d.provenance.document.includes('claude-opus-5-5'));
  t('generate: records which metric stalled', d.provenance.stalled_metric === 'gaze_fixation_ratio');
  t('generate: keeps the model\'s rationale', d.provenance.rationale.includes('word retrieval'));
  t('generate: is telemetry gated', d.telemetry_gated === true);
  t('generate: passes the same gate as curriculum drills', validateProposedDrill(d, METRICS).ok);
}

/* ---------- the gate rejects what the schema cannot express ---------- */
{
  const offTarget = { ...GOOD, target_metrics: ['blink_rate'], graduation: [{ metric: 'blink_rate', op: '<=', value: 20 }] };
  const r = await generateDrill({ metric: 'gaze_fixation_ratio', registry, efficacy: new EfficacyModel(),
    client: fakeClient(reply(offTarget), reply(offTarget)) });
  t('gate: rejects a drill that does not target the stalled metric', !r.ok);
  t('gate: says why', r.errors.some(e => e.includes('stalled metric')), JSON.stringify(r.errors));
}
{
  const noCues = { ...GOOD, intervention_cues: [] };
  const r = await generateDrill({ metric: 'gaze_fixation_ratio', registry, efficacy: new EfficacyModel(),
    client: fakeClient(reply(noCues), reply(noCues)) });
  t('gate: rejects a drill with no intervention cues', !r.ok);
}
{
  const badOp = { ...GOOD, graduation: [{ metric: 'gaze_fixation_ratio', op: '~=', value: 0.75 }] };
  const r = await generateDrill({ metric: 'gaze_fixation_ratio', registry, efficacy: new EfficacyModel(),
    client: fakeClient(reply(badOp), reply(badOp)) });
  t('gate: rejects an unrecognised operator', !r.ok && r.errors.some(e => e.includes('bad op')));
}

/* ---------- repair round-trip ---------- */
{
  seen.length = 0;
  const broken = { ...GOOD, target_metrics: ['blink_rate'] };
  const r = await generateDrill({ metric: 'gaze_fixation_ratio', registry, efficacy: new EfficacyModel(),
    client: fakeClient(reply(broken), reply(GOOD)) });
  t('repair: a rejected first attempt is retried', r.ok, JSON.stringify(r.errors));
  t('repair: the retry is flagged', r.drill?.provenance?.repaired === true);
  t('repair: the second prompt states what was wrong',
    seen[1].messages[0].content.includes('previous attempt was rejected'));
  t('repair: the second prompt names the specific failure',
    seen[1].messages[0].content.includes('stalled metric'));
}
{
  const broken = { ...GOOD, target_metrics: ['blink_rate'] };
  seen.length = 0;
  const r = await generateDrill({ metric: 'gaze_fixation_ratio', registry, efficacy: new EfficacyModel(),
    client: fakeClient(reply(broken), reply(broken)) });
  t('repair: gives up after one retry rather than looping', !r.ok && seen.length === 2, `calls=${seen.length}`);
}

/* ---------- API failure modes ---------- */
{
  const refusal = { stop_reason: 'refusal', stop_details: { category: 'cyber', explanation: 'declined' }, content: [] };
  const r = await generateDrill({ metric: 'wpm', registry, efficacy: new EfficacyModel(), client: fakeClient(refusal) });
  t('failure: a refusal is caught and reported', !r.ok && r.fatal && r.errors[0].includes('LLMRefused'));
}
{
  const truncated = { stop_reason: 'max_tokens', model: 'm', content: [{ type: 'text', text: '{"name":' }] };
  const r = await generateDrill({ metric: 'wpm', registry, efficacy: new EfficacyModel(), client: fakeClient(truncated) });
  t('failure: truncation is caught before parsing', !r.ok && r.errors[0].includes('LLMMalformed'));
}
{
  const garbage = { stop_reason: 'end_turn', model: 'm', content: [{ type: 'text', text: 'here is your drill!' }] };
  const r = await generateDrill({ metric: 'wpm', registry, efficacy: new EfficacyModel(), client: fakeClient(garbage) });
  t('failure: non-JSON output is caught', !r.ok && r.errors[0].includes('LLMMalformed'));
}
{
  const r = await generateDrill({ metric: 'not_a_metric', registry, efficacy: new EfficacyModel(), client: fakeClient(reply(GOOD)) });
  t('failure: an unknown metric is rejected before any API call', !r.ok && r.errors[0].includes('unknown metric'));
}

/* ---------- retry policy ---------- */
{
  let calls = 0;
  const flaky = async () => { calls++; if (calls < 3) { const e = new Error('503'); e.retryable = true; throw e; } return 'ok'; };
  const got = await withRetry(flaky, { baseMs: 0, sleep: async () => {} });
  t('retry: retries a retryable failure', got === 'ok' && calls === 3);
}
{
  let calls = 0;
  const hard = async () => { calls++; throw new Error('400 bad request'); };
  let threw = false;
  try { await withRetry(hard, { baseMs: 0, sleep: async () => {} }); } catch { threw = true; }
  t('retry: does not retry a non-retryable failure', threw && calls === 1, `calls=${calls}`);
}
{
  let threw = null;
  try { await askForJSON({ client: fakeClient(Object.assign(new Error('nope'), { status: 401 })), system: 's', user: 'u', schema: {} }); }
  catch (e) { threw = e; }
  t('retry: 401 becomes LLMUnavailable, not a retry loop', threw instanceof LLMUnavailable);
}

/* ---------- the stall trigger ---------- */
{
  const eff = new EfficacyModel();
  for (let i = 0; i < 8; i++) eff.record('3.2', 'wpm', 190, 172);   // something works
  const r = await generateIfStalled({ metric: 'wpm', registry, efficacy: eff, telemetry: {}, client: fakeClient(reply(GOOD)) });
  t('trigger: does not generate while an existing drill is working', !r.ok && r.skipped === 'not stalled');
}
{
  const eff = new EfficacyModel();
  const good = { ...GOOD, target_metrics: ['wpm'], graduation: [{ metric: 'wpm', op: 'between', value: [130, 150] }] };
  const r = await generateIfStalled({ metric: 'wpm', registry, efficacy: eff, telemetry: { wpm: 190 }, client: fakeClient(reply(good)) });
  t('trigger: generates when the metric has stalled', r.ok, JSON.stringify(r.errors));
  t('trigger: between predicate survives conversion',
    r.drill?.graduation?.wpm?.op === 'between' && r.drill.graduation.wpm.value[1] === 150);
}

/* ---------- a generated drill lives under the same rules as the rest ---------- */
{
  const eff = new EfficacyModel();
  const good = { ...GOOD, target_metrics: ['wpm'], graduation: [{ metric: 'wpm', op: 'between', value: [130, 150] }] };
  const r = await generateDrill({ metric: 'wpm', registry, efficacy: eff, client: fakeClient(reply(good)) });
  const drill = r.drill;
  for (let i = 0; i < 8; i++) eff.record(drill.id, 'wpm', 190, 191);   // it does not work
  const pruned = eff.prune([drill]).map(p => p.id);
  t('lifecycle: an ineffective generated drill is pruned', pruned.includes(drill.id));

  const eff2 = new EfficacyModel();
  for (let i = 0; i < 8; i++) eff2.record(drill.id, 'wpm', 190, 172); // it works
  t('lifecycle: an effective generated drill is kept', eff2.prune([drill]).length === 0);
}

/* ---------- the prompt feeds real efficacy numbers, not placeholders ---------- */
{
  seen.length = 0;
  const eff = new EfficacyModel();
  for (let i = 0; i < 6; i++) eff.record('3.2', 'wpm', 190, 191);   // Pasta-Sauce measurably useless
  await generateDrill({ metric: 'wpm', registry, efficacy: eff, client: fakeClient(reply(GOOD)) });
  const body = seen[0].messages[0].content;
  t('evidence: the real measured effect reaches the prompt', body.includes('Pasta-Sauce'));
  t('evidence: it is reported as a session count', /over 6 sessions/.test(body), body.slice(0, 400));
}

console.log(pass.map(s => '  PASS  ' + s).join('\n'));
if (fail.length) console.log('\n' + fail.map(s => '  FAIL  ' + s).join('\n'));
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
