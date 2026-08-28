#!/usr/bin/env node
/**
 * The whole release is one command:
 *
 *   node release.mjs 0.1.0             release for real
 *   node release.mjs 0.1.0 --dry-run   stop before anything is committed
 *
 * It demands a changelog entry, runs the full test gate, bumps the version,
 * asks you to type the version back, then commits, tags and pushes. The
 * pushed v* tag starts .github/workflows/publish.yml, which re-runs the
 * tests and publishes to npm with provenance. Publishing by hand skips the
 * gate and loses the provenance badge; don't.
 *
 * Ordinary pushes publish nothing. Only a v* tag does.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

const version = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

const die = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};
const run = (command) => execSync(command, { stdio: 'inherit' });
const capture = (command) => execSync(command, { encoding: 'utf8' }).trim();

if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) die('usage: node release.mjs X.Y.Z [--dry-run]');

if (capture('git branch --show-current') !== 'main') die('release from main only');
if (capture('git status --porcelain') !== '') die('working tree not clean; commit or stash first');

const changelog = readFileSync('CHANGELOG.md', 'utf8');
if (!changelog.includes(`## [${version}]`)) {
  die(`CHANGELOG.md has no "## [${version}]" entry. Write what changed first; the changelog is part of the release.`);
}

console.log('Running the test gate…');
run('npm test');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
console.log(`\n  ${pkg.name}: ${pkg.version} → ${version}`);
run(`git log --oneline v${pkg.version}..HEAD 2>/dev/null || git log --oneline -10`);

if (dryRun) {
  console.log('\n--dry-run: stopping before any change is committed.');
  process.exit(0);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const typed = await rl.question(`\nType the version to release (${version}) to confirm: `);
rl.close();
if (typed.trim() !== version) die('confirmation did not match; nothing released');

pkg.version = version;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
run(`git commit -am "Release v${version}"`);
// Annotated, and pushed by name: --follow-tags ignores lightweight tags,
// which once left a release tagged locally with no publish run (v0.1.0).
run(`git tag -a v${version} -m "v${version}"`);
run(`git push origin main v${version}`);

// The repo description leads with the version; keep it honest. Best effort:
// a missing gh must never fail a release.
try {
  const { listChecks } = await import('./dist/battery.js');
  const description = `v${version} · Testing for MCP servers: an in-memory harness and matchers for your own tests, plus npx checkmcp, ${listChecks().length} spec-cited conformance checks in one command across tools, resources and prompts.`;
  execSync(`gh api repos/gregkozakiewicz/checkmcp -X PATCH -f description=${JSON.stringify(description)}`, { stdio: 'ignore' });
} catch {}

console.log(`\n✓ v${version} pushed. The publish Action takes it from here:`);
console.log('  https://github.com/gregkozakiewicz/checkmcp/actions');
