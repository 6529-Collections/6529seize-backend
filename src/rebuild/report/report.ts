import * as fs from 'node:fs';
import * as path from 'node:path';
import { TableClass } from '@/rebuild/manifest.types';
import { RegistryProblem } from '@/rebuild/registry-check';
import { SourceViolation } from '@/rebuild/guard/source-guard';
import { ProbeDifference } from '@/rebuild/probes/probe-runner';
import { TableDiff } from '@/rebuild/snapshot/table-snapshot';

export interface StepOutcome {
  readonly kind: 'schema' | 'seed' | 'rebuilder' | 'api';
  readonly id: string;
  readonly area: string | null;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly log: string;
  readonly rowsWritten?: Record<string, number>;
  /** Command steps that don't run Node have no source guard. */
  readonly guarded: boolean;
}

/** Where one source's answers came from in this run. */
export interface SourceInfo {
  readonly url: string | null;
  readonly mode: 'none' | 'replay' | 'record' | 'live' | 'local';
  /** What made the recording: a devnet, anvil, or written by hand. */
  readonly provenance: string | null;
  /**
   * Not a devnet's recording (written by hand, or a stand-in such as the
   * harness relay): doesn't count for the final proof.
   */
  readonly provisional: boolean;
}

export interface AreaSummary {
  readonly area: string;
  readonly tables: number;
  readonly index: number;
  readonly kept: number;
  readonly rebuilt: number;
  readonly pending: number;
  readonly probes: number;
  readonly differences: number;
  readonly unproven: number;
  /** INDEX tables with rows after the seeds. */
  readonly seeded: number;
  readonly failedSteps: number;
}

export interface KeptRead {
  readonly step: string;
  readonly area: string;
  readonly table: string;
  readonly class: TableClass;
}

export interface RunReport {
  readonly verdict: 'PASS' | 'FAIL';
  readonly scope: string;
  readonly mark: 'head' | 'switch';
  readonly final: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly backendHead: string | null;
  readonly mysql: { readonly version: string | null; readonly port: number };
  readonly sources: Readonly<Record<string, SourceInfo>>;
  readonly classes: Record<TableClass, number>;
  readonly areas: AreaSummary[];
  readonly registryProblems: RegistryProblem[];
  readonly pending: { area: string; table: string }[];
  /** Tables marked planned whose code isn't in this tree. */
  readonly planned: { area: string; table: string }[];
  /** Tables a manifest keeps or rebuilds that a fresh schema doesn't have. */
  readonly notInSchema: { area: string; table: string }[];
  /** Rebuilders that read kept tables (ephemeral, provider, exempt). */
  readonly keptReads: KeptRead[];
  readonly steps: StepOutcome[];
  readonly violations: SourceViolation[];
  readonly probes: {
    readonly calls: number;
    /** Probes that failed or answer differently after the rebuild. */
    readonly differences: ProbeDifference[];
    /** Probes whose first answer was 4xx or carried no data. */
    readonly unproven: ProbeDifference[];
    /** INDEX tables in scope that no probe read in the first pass. */
    readonly unreadTables: string[];
  };
  readonly routes: {
    readonly documented: number;
    readonly probed: number;
    readonly waived: number;
    readonly open: string[];
  };
  readonly tables: {
    readonly rebuilt: string[];
    readonly diffs: TableDiff[];
    readonly notEmptyAfterDrop: string[];
    /** Rows in each INDEX table after the seeds, before the first pass. */
    readonly seededRows: Record<string, number>;
  };
  readonly failures: string[];
  readonly notes: string[];
}

const COUNT_ORDER: TableClass[] = [
  'INDEX',
  'EPHEMERAL',
  'PROVIDER',
  'SCHEMA',
  'VIEW',
  'RETIRED',
  'EXEMPT'
];

/** The first lines of a report: what ran and the verdict. */
export function headline(report: RunReport): string[] {
  const total = COUNT_ORDER.reduce((n, c) => n + report.classes[c], 0);
  const classes = COUNT_ORDER.map(
    (c) => `${c.toLowerCase()} ${report.classes[c]}`
  ).join(', ');
  const rebuilt = report.tables.rebuilt.length;
  const differing = report.tables.diffs.filter((d) => !d.same).length;
  const failed = report.steps.filter((s) => s.exitCode !== 0).length;
  const provisional = Object.entries(report.sources)
    .filter(([, info]) => info.provisional)
    .map(([name]) => name);
  return [
    `${report.scope}, mark ${report.mark}${report.final ? ', final' : ''}, backend ${report.backendHead ?? 'unknown'}: ${report.verdict}`,
    `tables ${total}: ${classes}; rebuilt ${rebuilt}, pending ${report.pending.length}, planned ${report.planned.length}, differing ${differing}`,
    `probes ${report.probes.calls}: differ ${report.probes.differences.length}, unproven ${report.probes.unproven.length}; INDEX tables no probe read ${report.probes.unreadTables.length}`,
    `GET routes ${report.routes.documented}: probed ${report.routes.probed}, waived ${report.routes.waived}, open ${report.routes.open.length}`,
    `steps ${report.steps.length}: failed ${failed}; source violations ${report.violations.length}; provisional sources ${provisional.length ? provisional.join(', ') : 'none'}`
  ];
}

function section(title: string, lines: string[]): string[] {
  return lines.length ? ['', `## ${title}`, '', ...lines] : [];
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function areaTable(areas: readonly AreaSummary[]): string[] {
  if (!areas.length) return [];
  return [
    '| Area | Tables | INDEX | Seeded | Kept | Rebuilt | Pending | Probes | Differ | Unproven | Failed steps |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...areas.map(
      (l) =>
        `| ${l.area} | ${l.tables} | ${l.index} | ${l.seeded} | ${l.kept} | ${l.rebuilt} | ${l.pending} | ${l.probes} | ${l.differences} | ${l.unproven} | ${l.failedSteps} |`
    )
  ];
}

function sourceLines(sources: RunReport['sources']): string[] {
  return Object.entries(sources).map(([name, info]) => {
    const where = info.url ? ` at ${info.url}` : '';
    const from = info.provenance ? `, from ${info.provenance}` : '';
    const flag = info.provisional
      ? " (provisional: not a devnet's recording)"
      : '';
    return `- ${name}: ${info.mode}${where}${from}${flag}`;
  });
}

function byArea(
  items: readonly { area: string; table: string }[]
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const { area, table } of items) {
    result.set(area, [...(result.get(area) ?? []), table]);
  }
  return result;
}

function areaLists(
  items: readonly { area: string; table: string }[]
): string[] {
  return Array.from(byArea(items)).map(
    ([area, tables]) => `- ${area} (${tables.length}): ${tables.join(', ')}`
  );
}

export function renderMarkdown(report: RunReport): string {
  return [
    `# Rebuild check: ${report.verdict}`,
    '',
    '```text',
    ...headline(report),
    '```',
    '',
    `Started ${report.startedAt}, finished ${report.finishedAt}. MySQL ${report.mysql.version ?? 'not started'} on port ${report.mysql.port}.`,
    ...section(
      'Failures',
      report.failures.map((failure) => `- ${failure}`)
    ),
    ...section(
      'Registry problems',
      report.registryProblems.map((p) => `- ${p.kind}: ${p.detail}`)
    ),
    ...section('Areas', areaTable(report.areas)),
    ...section('Sources', sourceLines(report.sources)),
    ...section(
      'Steps',
      report.steps.map(
        (s) =>
          `- ${s.kind} ${s.id}${s.area ? ` (${s.area})` : ''}: exit ${s.exitCode}${s.timedOut ? ', timed out' : ''}, ${seconds(s.durationMs)}${s.guarded ? '' : ', no source guard'}${s.rowsWritten ? `, rows ${JSON.stringify(s.rowsWritten)}` : ''}. Log: ${s.log}`
      )
    ),
    ...section(
      'Source violations',
      report.violations.map((v) => `- pid ${v.pid} tried ${v.target}`)
    ),
    ...section(
      'Probe differences',
      report.probes.differences.map(
        (d) =>
          `- ${d.id} (${d.area}): ${d.reason}\n  - before: \`${d.before.slice(0, 300)}\`\n  - after: \`${d.after.slice(0, 300)}\``
      )
    ),
    ...section(
      'Probes that prove nothing yet',
      report.probes.unproven.map(
        (d) =>
          `- ${d.id} (${d.area}): ${d.reason}: \`${d.before.slice(0, 120)}\``
      )
    ),
    ...section(
      'Tables that differ after the rebuild',
      report.tables.diffs
        .filter((d) => !d.same)
        .map(
          (d) =>
            `- ${d.table}: ${d.rowsBefore} rows before, ${d.rowsAfter} after; missing ${d.missing.join(' ') || 'none'}; extra ${d.extra.join(' ') || 'none'}; changed ${d.changed.join(' ') || 'none'}`
        )
    ),
    ...section(
      'Rebuilders that read kept tables',
      report.keptReads.map(
        (r) => `- ${r.step} (${r.area}) reads ${r.table}, ${r.class}`
      )
    ),
    ...section(
      'INDEX tables no probe read',
      report.probes.unreadTables.length
        ? [report.probes.unreadTables.join(', ')]
        : []
    ),
    ...section(
      'GET routes no probe calls and no waiver names',
      report.routes.open.length ? [report.routes.open.join(', ')] : []
    ),
    ...section(
      'Planned tables whose code is not in this tree',
      areaLists(report.planned)
    ),
    ...section(
      'Tables a fresh schema does not have',
      areaLists(report.notInSchema)
    ),
    ...section(
      'Pending: INDEX tables without a rebuilder',
      areaLists(report.pending)
    ),
    ...section(
      'Notes',
      report.notes.map((note) => `- ${note}`)
    ),
    ''
  ].join('\n');
}

/** One line per run for the status file. */
export function statusLine(report: RunReport, runDir: string): string {
  return `- ${report.finishedAt} ${report.scope}: ${report.verdict}, rebuilt ${report.tables.rebuilt.length}, pending ${report.pending.length}, probe differences ${report.probes.differences.length}, failures ${report.failures.length}. ${runDir}`;
}

export function writeReport(
  runDir: string,
  statusFile: string,
  report: RunReport
): void {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`
  );
  fs.writeFileSync(path.join(runDir, 'report.md'), renderMarkdown(report));
  fs.appendFileSync(statusFile, `${statusLine(report, runDir)}\n`);
}
