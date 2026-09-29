/**
 * Tier 2 of the learning layer: authoring a new drill when the curriculum runs out.
 *
 * This only fires when a metric has stalled AND nothing in the registry shows a
 * trusted positive effect on it. What comes back is a *candidate*, not a drill:
 * it must clear the schema gate, must actually target the stalled metric, and
 * then earns or loses its place on the same evidence as everything else. A
 * generated drill that does not move the number is pruned.
 */

import { askForJSON, withRetry, DEFAULT_MODEL } from './llm.mjs';
import { validateProposedDrill } from './tools.mjs';

export const PROMPT_VERSION = 'drill-gen/1';

const OPS = ['>=', '<=', '>', '<', '==', 'between'];

/** JSON Schema for the model's reply. Mirrors validateProposedDrill. */
export function drillSchema(metrics) {
  return {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Three to five words, in the voice of the curriculum.' },
      target_metrics: {
        type: 'array', minItems: 1, maxItems: 2,
        items: { type: 'string', enum: metrics },
      },
      graduation: {
        type: 'array', minItems: 1, maxItems: 3,
        items: {
          type: 'object',
          properties: {
            metric: { type: 'string', enum: metrics },
            op: { type: 'string', enum: OPS },
            value: {
              anyOf: [
                { type: 'number' },
                { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
              ],
            },
          },
          required: ['metric', 'op', 'value'],
          additionalProperties: false,
        },
      },
      duration_s: { type: 'integer', minimum: 30, maximum: 900 },
      coach_brief: { type: 'string', description: 'Second person, direct, mechanics-focused. No praise, no hedging.' },
      protocol: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string' } },
      intervention_cues: {
        type: 'array', minItems: 1, maxItems: 4,
        items: {
          type: 'object',
          properties: {
            trigger: { type: 'string' },
            say: { type: 'string' },
          },
          required: ['trigger', 'say'],
          additionalProperties: false,
        },
      },
      rationale: { type: 'string', description: 'Why this mechanism should move the stalled metric.' },
    },
    required: ['name', 'target_metrics', 'graduation', 'duration_s', 'coach_brief', 'protocol', 'intervention_cues', 'rationale'],
    additionalProperties: false,
  };
}

const SYSTEM = `You are VERA, an on-camera performance coach, authoring a new training drill.

Your coaching philosophy:
- The lens is a confidant, not an audience.
- Presence over perfection. Apologies and mid-take restarts are penalised; forward momentum is not.
- The camera captures internal cognition. Stillness reads as authority; theatrical projection reads as dishonest.
- Feedback is always a concrete physical adjustment, never "be more confident".

You are writing a drill because an existing curriculum has stalled: a speaker's
measurement on one dimension has stopped improving, and no drill already in the
repertoire is moving it for them. Your drill must attack that specific dimension
by a DIFFERENT mechanism than the ones that have already failed.

Hard constraints:
- The speaker is alone with a phone or webcam. No second person, no equipment beyond
  what is already in a room: a chair, a window, tape, a stack of books.
- The drill must be measurable by the listed telemetry. Do not invent a measurement.
- Every graduation predicate must use a metric from the provided list.
- At least one graduation predicate must be on the stalled metric itself.
- Duration between 30 and 900 seconds.
- Write the coach_brief in the voice above: second person, direct, mechanically specific.
  No praise. No hedging. Two to four sentences.
- Intervention cues are what you say in the moment when a specific failure appears.
  Keep them short enough to say over someone who is mid-take.`;

function describeMetric(name, meta) {
  const [lo, hi] = meta.target;
  return `- ${name} (${meta.unit}): target ${lo} to ${hi}. Too low: ${meta.deficient}. Overcorrected: ${meta.overcorrected}.`;
}

/** Build the user turn: the stall, the evidence, and what has already failed. */
export function buildPrompt({ metric, registryMetrics, tried, telemetry }) {
  const meta = registryMetrics[metric];
  const lines = [];

  lines.push(`STALLED METRIC: ${metric}`);
  lines.push(`Target band: ${meta.target[0]} to ${meta.target[1]} ${meta.unit}.`);
  if (Number.isFinite(telemetry?.[metric])) {
    lines.push(`The speaker currently measures ${telemetry[metric]} ${meta.unit}.`);
  }
  lines.push('');

  if (tried?.length) {
    lines.push('ALREADY TRIED, WITH MEASURED EFFECT (band-widths of improvement per session):');
    for (const t of tried) {
      const verdict = t.effect > 0.05 ? 'slight positive, not enough'
                    : t.effect < -0.05 ? 'made it worse'
                    : 'no measurable effect';
      lines.push(`- "${t.name}" over ${t.n} sessions: ${t.effect.toFixed(2)} (${verdict}). Mechanism: ${t.mechanism}`);
    }
    lines.push('');
    lines.push('Do not propose a variation of any of the above. Find a different mechanism.');
    lines.push('');
  }

  lines.push('AVAILABLE TELEMETRY — you may only write graduation predicates against these:');
  for (const [name, m] of Object.entries(registryMetrics)) lines.push(describeMetric(name, m));
  lines.push('');
  lines.push(`Author one drill that attacks ${metric}.`);

  return lines.join('\n');
}

/** Convert the model's array-of-predicates into the registry's object form. */
function toGraduationObject(arr) {
  const out = {};
  for (const g of arr) out[g.metric] = { op: g.op, value: g.value };
  return out;
}

/**
 * Generate one candidate drill. Returns {ok, drill} or {ok:false, errors}.
 *
 * `client` is injectable so this is testable without the SDK or an API key.
 */
export async function generateDrill({
  metric,
  registry,
  efficacy,
  telemetry = {},
  client = null,
  model = DEFAULT_MODEL,
  platform = 'anthropic',
  now = () => Date.now(),
}) {
  const metrics = Object.keys(registry.metrics);
  if (!metrics.includes(metric)) {
    return { ok: false, errors: [`unknown metric: ${metric}`] };
  }

  // What has already been tried on this metric, and how badly it went.
  const tried = (registry.drills || [])
    .filter(d => (d.target_metrics || []).includes(metric))
    .map(d => {
      const e = efficacy?.effect ? efficacy.effect(d.id, metric) : { mean: 0, n: 0 };
      return { name: d.name, mechanism: d.coach_brief.replace(/^AUTHORED\.\s*/, '').slice(0, 160), effect: e.mean, n: e.n };
    })
    .filter(t => t.n > 0)
    .sort((a, b) => b.effect - a.effect)
    .slice(0, 6);

  const schema = drillSchema(metrics);
  const system = SYSTEM;
  const user = buildPrompt({ metric, registryMetrics: registry.metrics, tried, telemetry });

  const attempt = async extraInstruction => {
    const { data, usage, model: served } = await withRetry(() => askForJSON({
      client, schema, system, model, platform,
      user: extraInstruction ? `${user}\n\nYour previous attempt was rejected:\n${extraInstruction}\nFix it and return the whole drill again.` : user,
    }));
    return { data, usage, served };
  };

  let result;
  try {
    result = await attempt(null);
  } catch (err) {
    return { ok: false, errors: [`${err.name || 'Error'}: ${err.message}`], fatal: true };
  }

  let candidate = shape(result.data, metric, result.served, now(), registry);
  let check = gate(candidate, metrics, metric, registry.metrics);

  // One repair round-trip. If it fails twice, the model is not going to get there.
  if (!check.ok) {
    try {
      const retry = await attempt(check.errors.map(e => `- ${e}`).join('\n'));
      candidate = shape(retry.data, metric, retry.served, now(), registry);
      check = gate(candidate, metrics, metric, registry.metrics);
      candidate.provenance.repaired = true;
    } catch (err) {
      return { ok: false, errors: [...check.errors, `repair failed: ${err.message}`] };
    }
  }

  if (!check.ok) return { ok: false, errors: check.errors, candidate };
  return { ok: true, drill: candidate };
}

export function shape(data, metric, servedModel, at, registry, source = 'generated') {
  const graduation = toGraduationObject(data.graduation || []);
  const stage = Math.max(...registry.drills.map(d => d.stage));
  return {
    id: `${source === 'researched' ? 'res' : 'gen'}.${metric}.${at.toString(36)}`,
    stage,
    name: data.name,
    source,
    category: source,
    provenance: {
      lineage: source === 'researched'
        ? 'Researched from external material against a stalled metric'
        : 'Generated by VERA against a stalled metric',
      document: `${PROMPT_VERSION} · model ${servedModel} · ${new Date(at).toISOString()}`,
      stalled_metric: metric,
      rationale: data.rationale,
    },
    duration_s: data.duration_s,
    reps_target: 3,
    telemetry_gated: true,
    target_metrics: data.target_metrics,
    graduation,
    coach_brief: data.coach_brief,
    protocol: data.protocol,
    intervention_cues: data.intervention_cues,
  };
}

/**
 * A graduation bar must be non-degenerate: something a speaker can both fail
 * and pass. The failures worth catching are directional and silent —
 * `gaze_fixation_ratio >= 0` passes everyone the moment it is written, and
 * `<= 1` on any ratio does the same. Neither is caught by the schema, and both
 * quietly destroy progression.
 *
 * This checks against the metric's PLAUSIBLE measurement range, not its target
 * band. Leniency is a legitimate pedagogical choice — the Yap Protocol
 * graduates at under 5% fillers against a system-wide benchmark of 1.3%,
 * because Stage 1 is about not freezing, not about polish. Judging bars
 * against the target band would reject the curriculum's own drills.
 */
export function thresholdSane(metric, rule, metricsTable) {
  const meta = metricsTable[metric];
  if (!meta?.plausible) return true;            // supporting measure, no documented range
  const [min, max] = meta.plausible;

  if (rule.op === 'between') {
    if (!Array.isArray(rule.value) || rule.value.length !== 2) return false;
    const [a, b] = rule.value;
    if (!(a >= min && b <= max && a < b)) return false;
    return (b - a) < (max - min);               // a band spanning everything is no band
  }
  if (typeof rule.value !== 'number') return false;
  if (rule.op === '==') return rule.value >= min && rule.value <= max;
  // strict: a bar AT the floor or ceiling is vacuous in one direction and
  // impossible in the other, and which it is depends on the operator.
  return rule.value > min && rule.value < max;
}

/** The schema gate, plus the rules the schema cannot express. */
export function gate(candidate, metrics, stalledMetric, metricsTable = {}) {
  const base = validateProposedDrill(candidate, metrics);
  const errors = [...base.errors];

  if (!(candidate.target_metrics || []).includes(stalledMetric)) {
    errors.push(`target_metrics must include the stalled metric "${stalledMetric}"`);
  }
  if (!Object.keys(candidate.graduation || {}).includes(stalledMetric)) {
    errors.push(`graduation must contain a predicate on "${stalledMetric}"`);
  }
  if (!Array.isArray(candidate.intervention_cues) || !candidate.intervention_cues.length) {
    errors.push('at least one intervention cue is required');
  }
  for (const [m, rule] of Object.entries(candidate.graduation || {})) {
    if (!thresholdSane(m, rule, metricsTable)) {
      errors.push(`graduation bar on "${m}" is outside the plausible range for that metric`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * The full tier-2 trigger. Only generates when the metric has genuinely stalled —
 * generation is a last resort, not a first move.
 */
export async function generateIfStalled({ metric, registry, efficacy, telemetry, client, force = false, ...rest }) {
  if (!force && !efficacy.stalled(registry.drills, metric)) {
    return { ok: false, skipped: 'not stalled', errors: [] };
  }
  return generateDrill({ metric, registry, efficacy, telemetry, client, ...rest });
}
