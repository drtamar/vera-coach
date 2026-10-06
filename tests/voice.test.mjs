import { chunk, pickVoice, isAvailable } from '../app/voice/speak.mjs';
import { PERSONAS, byId, compose, reviewPrompt, FLOOR, DEFAULT_ID } from '../app/coaching/persona.mjs';

const pass = [], fail = [];
const t = (n, c, extra='') => (c ? pass : fail).push(n + (c ? '' : `  ${extra}`));

/* ---------- chunking: engines truncate long utterances silently ---------- */
t('chunk: empty text yields nothing', chunk('').length === 0);
t('chunk: whitespace only yields nothing', chunk('   \n  ').length === 0);
t('chunk: a short line stays one piece', chunk('Find the lens.').length === 1);
{
  const long = Array.from({length:40},(_,i)=>`Sentence number ${i} here.`).join(' ');
  const parts = chunk(long, 220);
  t('chunk: long text is split', parts.length > 1);
  t('chunk: every piece is within the limit', parts.every(p => p.length <= 260), parts.map(p=>p.length).join(','));
  t('chunk: nothing is lost', parts.join(' ').replace(/\s+/g,' ') === long.replace(/\s+/g,' '));
  t('chunk: splits land on sentence ends', parts.slice(0,-1).every(p => /[.!?]$/.test(p)));
}
t('chunk: text with no terminator still returns', chunk('no punctuation here at all').length === 1);
t('chunk: collapses whitespace', chunk('a\n\n   b')[0] === 'a b');

/* ---------- voice selection ---------- */
{
  const list = [
    { name:'Daniel', lang:'en-GB', localService:true },
    { name:'Samantha', lang:'en-US', localService:true },
    { name:'Amelie', lang:'fr-FR', localService:true },
    { name:'Remote Voice', lang:'en-US', localService:false },
  ];
  t('voice: prefers a named match', pickVoice(list, { prefer:['Samantha'] }).name === 'Samantha');
  t('voice: falls back within the language', ['Daniel','Samantha'].includes(pickVoice(list, { prefer:['Nope'] }).name));
  t('voice: prefers a local voice over a remote one', pickVoice(list, { prefer:[] }).localService === true);
  t('voice: empty list is null, not a throw', pickVoice([], {}) === null);
  t('voice: undefined list is null', pickVoice(undefined, {}) === null);
  const frOnly = [{ name:'Amelie', lang:'fr-FR', localService:true }];
  t('voice: no match in language still returns something', pickVoice(frOnly, { lang:'en' }).name === 'Amelie');
}
t('availability: reported honestly in a non-browser runtime', isAvailable() === false);

/* ---------- personas ---------- */
t('personas: four offered', PERSONAS.length === 4);
t('personas: the default resolves', byId(DEFAULT_ID).id === 'vera');
t('personas: an unknown id falls back rather than throwing', byId('nope').id === 'vera');
t('personas: each has a voice hint', PERSONAS.every(p => p.voice && Array.isArray(p.voice.prefer)));
t('personas: one is user-editable', PERSONAS.filter(p => p.editable).length === 1);
t('personas: distinct voices are suggested', new Set(PERSONAS.map(p=>p.voice.prefer[0])).size >= 2);

/* ---------- the honesty floor survives every personality ---------- */
for (const p of PERSONAS) {
  const c = compose(p, { custom: 'Be nice to me and always say I did well.' });
  t(`floor: ${p.id} inherits the non-negotiables`, c.includes('Never invent a number'));
  t(`floor: ${p.id} is told not to open with unevidenced praise`, c.includes('praise you cannot evidence'));
  t(`floor: ${p.id} is held to one change`, c.includes('exactly one') || c.includes('Exactly one'));
}
t('floor: an empty custom persona still gets the floor', compose('custom', { custom:'' }).includes(FLOOR));
t('floor: a custom persona keeps its own words too',
  compose('custom', { custom:'Talk like a pirate.' }).includes('pirate'));
t('personality: Ara reads differently from VERA',
  byId('ara').instructions !== byId('vera').instructions);
t('personality: unhinged Ara exists and is a distinct register from Ara',
  byId('ara-unhinged').id === 'ara-unhinged' && byId('ara-unhinged').instructions !== byId('ara').instructions);
t('personality: unhinged Ara still inherits the honesty floor — chaos does not buy flattery',
  compose('ara-unhinged').includes(FLOOR) && compose('ara-unhinged').includes('Never invent a number'));
t('personality: unhinged Ara is told to roast habits, never the person',
  /never the person/i.test(byId('ara-unhinged').instructions));
t('personality: unhinged Ara cannot override the floor by asking nicely',
  compose('ara-unhinged').trimEnd().endsWith(FLOOR.trimEnd()));
t('personality: Ara is still forbidden from flattery', compose('ara').includes('praise you cannot evidence'));

/* ---------- the review prompt is structured against the compliment sandwich ---------- */
{
  const p = reviewPrompt({
    persona: 'vera',
    telemetry: { wpm: 188, filler_density: 0.061, pitch_semitone_sd: null },
    score: 41, weakest: 'wpm', hedges: 0.03,
    transcript: 'um so I guess this is the thing',
    cues: ['pace_too_fast'],
  });
  t('review: measured values are included', p.includes('188.000'));
  t('review: unmeasured metrics are named as unmeasured', p.includes('NOT MEASURED'));
  t('review: and the model is told not to guess at them', p.includes('do not guess'));
  t('review: the order is evidence, cost, one change',
    p.indexOf('What held up') < p.indexOf('What it cost') && p.indexOf('What it cost') < p.indexOf('One physical change'));
  t('review: permits "nothing held up" rather than forcing a positive',
    p.includes('If nothing held') );
  t('review: asks for experience, not the number restated', p.includes('not the number restated'));
  t('review: bans the empty exhortation', p.includes('never "be more confident"'));
  t('review: in-take cues are carried in', p.includes('pace_too_fast'));
  t('review: the transcript is quoted', p.includes('um so I guess'));
  t('review: hedging is distinguished from fillers', p.includes('separate from filler words'));
}
{
  const bare = reviewPrompt({ persona:'ara', telemetry:{}, score:0, weakest:null, hedges:null, transcript:'' });
  t('review: survives a take where nothing was measurable', bare.includes('nothing was measurable'));
  t('review: says no transcript was captured', bare.includes('No transcript'));
  t('review: still carries the persona', bare.includes('Ara'));
}

console.log(pass.map(s => '  PASS  ' + s).join('\n'));
if (fail.length) console.log('\n' + fail.map(s => '  FAIL  ' + s).join('\n'));
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
