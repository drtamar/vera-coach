import { execFileSync } from 'node:child_process';

const suites = [
  { file: 'core.test.mjs',    name: 'scoring + learning' },
  { file: 'sensing.test.mjs', name: 'sensing fixtures' },
  { file: 'privacy.test.mjs', name: 'privacy invariant' },
  { file: 'tools.test.mjs',   name: 'tool schemas' },
  { file: 'live.test.mjs',    name: 'live coaching' },
  { file: 'session.test.mjs', name: 'drill sessions' },
  { file: 'auth.test.mjs',    name: 'auth + platforms' },
  { file: 'generate.test.mjs',name: 'drill generation' },
  { file: 'research.test.mjs',name: 'technique research' },
  { file: 'integration.test.mjs', name: 'real SDK integration' },
  { file: 'sandbox.test.mjs', name: 'sandbox browser', needs: 'playwright' },
  { file: 'onramp.test.mjs',  name: 'on-ramp browser', needs: 'playwright' },
];

let failed = 0, skipped = 0;
for (const s of suites) {
  if (s.needs) {
    try { await import(s.needs); }
    catch {
      console.log(`\n=== ${s.name} ===\n  SKIP  ${s.needs} not installed (npm i)`);
      skipped++; continue;
    }
  }
  console.log(`\n=== ${s.name} ===`);
  try {
    const out = execFileSync('node', [new URL(s.file, import.meta.url).pathname], { encoding: 'utf8' });
    console.log(out.trim().split('\n').slice(-1)[0]);
  } catch (e) {
    failed++;
    console.log((e.stdout || String(e)).trim());
  }
}
console.log(`\n${failed ? `${failed} suite(s) FAILED` : 'all suites passed'}${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed);
