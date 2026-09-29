#!/usr/bin/env node
/**
 * Flatten the sandbox for publishing as a standalone artifact.
 *
 *   node sandbox/build-publish.mjs [outdir]   (default: ./dist-sandbox)
 *
 * Served locally the page sits at /sandbox/ and imports `../app/...`. Published,
 * it sits at the root, so those become `./app/...`. Nothing else changes: the
 * engine modules are COPIED, never rewritten, so the published bench runs the
 * same code as the repo. Rewriting them would reintroduce exactly the drift the
 * sandbox exists to avoid.
 */
import { mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = process.argv[2] || join(ROOT, 'dist-sandbox');

/** Everything the page imports or fetches at runtime. */
export const RUNTIME_FILES = [
  'app/scoring/score.mjs',
  'app/learning/efficacy.mjs',
  'server/generate.mjs',
  'server/llm.mjs',
  'server/auth.mjs',
  'server/tools.mjs',
  'server/research.mjs',
  'registry/drills.json',
];

await rm(OUT, { recursive: true, force: true });
for (const f of RUNTIME_FILES) {
  await mkdir(dirname(join(OUT, f)), { recursive: true });
  await copyFile(join(ROOT, f), join(OUT, f));
}

const src = await readFile(join(ROOT, 'sandbox/index.html'), 'utf8');
const html = src
  .replaceAll("'../app/", "'./app/")
  .replaceAll("'../server/", "'./server/")
  .replaceAll("'../registry/", "'./registry/");

if (html === src) {
  console.error('Refusing to write: no relative paths were rewritten. Did the page layout change?');
  process.exit(1);
}
if (/['"]\.\.\//.test(html)) {
  console.error('Refusing to write: a ../ path survived the rewrite and would 404 when published.');
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'index.html'), html);

console.log(`\n  ${OUT}`);
console.log(`  index.html + ${RUNTIME_FILES.length} runtime files\n`);
console.log('  Publish index.html with the rest as supporting files.\n');
