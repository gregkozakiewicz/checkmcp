#!/usr/bin/env node
/**
 * Snapshot suite for the CLI itself, roast-style: fixture servers, frozen
 * expected outputs. Any change to a check, a message, the renderer or an
 * exit code shows up here as a diff before it can ship.
 *
 *   node tests/e2e/run.mjs            run all, exit 1 on any mismatch
 *   node tests/e2e/run.mjs --update   regenerate expected files (review the
 *                                     diff before committing: they are the
 *                                     contract)
 *
 * Runs dist/, not src/: what ships is what is tested. Build first.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const CLI = join(ROOT, 'dist/cli.js');
const EXPECTED = join(HERE, 'expected');
const UPDATE = process.argv.includes('--update');

if (!existsSync(CLI)) {
  console.error('dist/cli.js missing; run `npm run build` first.');
  process.exit(1);
}

// The version changes every release; the contract is everything else.
const normalize = (s) => s.replace(/checkmcp v\d+\.\d+\.\d+/g, 'checkmcp vX');

const CASES = [
  { name: 'clean', args: ['tests/fixtures/clean-server.mjs'], exit: 0 },
  { name: 'sloppy', args: ['tests/fixtures/sloppy-server.mjs'], exit: 1 },
  { name: 'empty', args: ['tests/fixtures/empty-server.mjs'], exit: 0 },
  { name: 'sloppy-only-schemas', args: ['tests/fixtures/sloppy-server.mjs', '--only', 'schemas'], exit: 1 },
  { name: 'list', args: ['--list'], exit: 0 },
  { name: 'unreachable', args: ['tests/fixtures/does-not-exist.mjs'], exit: 2 },
];

let failed = 0;
for (const { name, args, exit } of CASES) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
  const actual = normalize(`exit ${r.status}\n---\n${r.stdout}${r.stderr}`);
  const file = join(EXPECTED, `${name}.txt`);

  if (UPDATE) {
    writeFileSync(file, actual);
    console.log(`  ✓ ${name} (expected updated)`);
    continue;
  }
  if (!existsSync(file)) {
    failed++;
    console.log(`  ✗ ${name}: missing ${file}; run with --update`);
    continue;
  }
  const want = readFileSync(file, 'utf8');
  if (r.status !== exit) {
    failed++;
    console.log(`  ✗ ${name}: exit ${r.status}, expected ${exit}`);
    continue;
  }
  if (actual === want) {
    console.log(`  ✓ ${name}`);
    continue;
  }
  failed++;
  const a = actual.split('\n');
  const b = want.split('\n');
  const at = a.findIndex((line, i) => line !== b[i]);
  console.log(`  ✗ ${name}: first diff at line ${at + 1}`);
  console.log(`      want: ${b[at] ?? '(end)'}`);
  console.log(`      got:  ${a[at] ?? '(end)'}`);
}

process.exit(failed > 0 ? 1 : 0);
