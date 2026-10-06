#!/usr/bin/env node
/**
 * Print a persona as text you can paste into another assistant's custom
 * instructions — for example the Grok app, which uses your own subscription.
 *
 *   node bin/export-persona.mjs                 list personas
 *   node bin/export-persona.mjs ara-unhinged    print one
 *   node bin/export-persona.mjs custom "text"   your own words, plus the floor
 *
 * The honesty floor is always appended and cannot be removed here: a persona
 * that flatters would make the measurements pointless in any assistant.
 */
import { PERSONAS, byId, compose } from '../app/coaching/persona.mjs';

const [id, ...rest] = process.argv.slice(2);
if (!id) {
  for (const p of PERSONAS) console.log(`${p.id.padEnd(14)} ${p.name} — ${p.blurb}`);
  process.exit(0);
}
if (!PERSONAS.some(p => p.id === id)) {
  console.error(`unknown persona "${id}". Run without arguments to list them.`);
  process.exit(1);
}
process.stdout.write(compose(byId(id), { custom: rest.join(' ') }) + '\n');
