import type { Finding, Report } from './battery.js';

const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const GREEN = '\u001b[32m';
const RESET = '\u001b[0m';

/** Render a report the way the README promises it. `color: false` for pipes and tests. */
export function render(report: Report, version: string, color = process.stdout.isTTY): string {
  const c = (code: string, text: string) => (color ? `${code}${text}${RESET}` : text);
  const lines: string[] = [];

  lines.push(
    `checkmcp v${version} · ${report.server.name} ${report.server.version} · ${report.toolCount} tools found`,
    '',
  );

  for (const { category, examined, passed } of report.categories) {
    const mark = passed === examined ? c(GREEN, `${passed}/${examined}`) : c(RED, `${passed}/${examined}`);
    lines.push(`  ${category.padEnd(12)}${mark} passed`);
  }
  lines.push('');

  const failure = (f: Finding) => {
    const head = f.advisory ? c(YELLOW, `~ ${f.category}`) : c(RED, `✗ ${f.category}`);
    lines.push(`  ${head}: ${f.detail}`);
    if (f.advice) lines.push(c(DIM, `      ${f.advice}`));
    lines.push(c(DIM, `      ${f.check} · spec ${f.spec}`));
  };
  const findings = report.categories.flatMap((cat) => cat.findings);
  findings.filter((f) => !f.advisory).forEach(failure);
  findings.filter((f) => f.advisory).forEach(failure);
  if (findings.length > 0) lines.push('');

  const examined = report.categories.reduce((n, cat) => n + cat.examined, 0);
  const passed = report.categories.reduce((n, cat) => n + cat.passed, 0);
  const summary = `${passed}/${examined} passed, ${report.failed} failed (${report.advisories} advisory)`;
  lines.push(`  ${c(BOLD, summary)}`);

  return lines.join('\n');
}
