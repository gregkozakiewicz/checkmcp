import { SPEC_VERSION, listChecks, type Report } from './battery.js';

const SPEC_BASE = `https://modelcontextprotocol.io/specification/${SPEC_VERSION}/`;

/**
 * The report on the standard form: SARIF 2.1.0, which GitHub code scanning
 * ingests into pull-request annotations and the Security tab.
 *
 * Findings describe a live server, not a source file, so every result is
 * anchored to the target the battery was pointed at, line 1: the entry file
 * when checking over stdio, the URL when checking over HTTP.
 */
export function toSarif(report: Report, version: string, target: string): object {
  const findings = report.categories.flatMap((category) => category.findings);
  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'checkmcp',
            version,
            informationUri: 'https://github.com/gregkozakiewicz/checkmcp',
            rules: listChecks().map((check) => ({
              id: check.id,
              shortDescription: { text: check.id },
              helpUri: SPEC_BASE + check.spec,
              properties: { advisory: check.advisory },
            })),
          },
        },
        results: findings.map((finding) => ({
          ruleId: finding.check,
          level: finding.advisory ? 'note' : 'error',
          message: { text: finding.advice ? `${finding.detail}\n${finding.advice}` : finding.detail },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: target },
                region: { startLine: 1 },
              },
            },
          ],
        })),
      },
    ],
  };
}
