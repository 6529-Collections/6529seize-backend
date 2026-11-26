import * as fs from 'node:fs';
import * as path from 'node:path';
import { TableClass } from '@/rebuild/manifest.types';
import { RegistryProblem } from '@/rebuild/registry-check';
import { ExemptUntil, overdueLine } from '@/rebuild/run/exempt-until';
import { PlannedRowsPlan } from '@/rebuild/run/verdict';
import { SourceViolation } from '@/rebuild/guard/source-guard';
import { ProbeDifference } from '@/rebuild/probes/probe-runner';
import { TableDiff } from '@/rebuild/snapshot/table-snapshot';
import { redactUrl } from '@/rebuild/sources/running-source';

export interface StepOutcome {
  readonly kind: 'schema' | 'seed' | 'rebuilder' | 'api';
  readonly id: string;
  readonly area: string | null;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly log: string;
  /** Rows in each table the step writes, counted after it ran. */
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
   * Doesn't count for the final proof: written by hand, a stand-in such as
   * the harness relay, or answers nothing verifies (a gateway recording).
   */
  readonly provisional: boolean;
  /** Why it is provisional, when the report should say more. */
  readonly provisionalWhy?: string;
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
    /** Probes the API didn't answer in a pass, even on a second try. */
    readonly unanswered?: ProbeDifference[];
    /** Requests answered only on a second try, `<probe id> (pass A|B)`. */
    readonly retried?: string[];
    /** INDEX tables in scope that no probe read in the first pass. */
    readonly unreadTables: string[];
    /**
     * What stopped the run before pass B compared the answers ("step
     * rebuilder x.y"), or null when both passes ran. Until then the
     * differences and unproven probes above are not known.
     */
    readonly stoppedBefore: string | null;
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
    /**
     * Columns of the rebuilt tables the row comparison leaves out. A
     * column scoped by `where` is left out only of the rows it matches;
     * `scope` counts them on each side once the run has compared (null
     * before), and the rows it matched on one side only.
     */
    readonly volatileColumns: {
      table: string;
      column: string;
      reason: string;
      where?: string;
      scope?: {
        before: number;
        rowsBefore: number;
        after: number;
        rowsAfter: number;
        oneSide: number;
      } | null;
    }[];
    /** Rebuilt tables whose rows a declared rowKey keys, not the primary key. */
    readonly rowKeys: { table: string; columns: string[] }[];
    /**
     * Owned columns of the rebuilt tables left out of the comparison
     * because their owner doesn't run here, with why.
     */
    readonly ownedColumnsLeftOut: {
      table: string;
      column: string;
      owner: string;
      why: string;
    }[];
    /** The run's day (UTC), YYYY-MM-DD, that `until` days are judged against. */
    readonly day: string;
    /** EXEMPT tables exempt only until a day (see TableEntry.until). */
    readonly exemptUntil: ExemptUntil[];
    /**
     * Every plan of the running rebuilders' planned rows (seeded rows only
     * a later change rebuilds), by table: the planned rows missing from
     * the rebuild, up to 20 of their keys, and each plan.
     */
    readonly plannedRows: {
      table: string;
      rows: number;
      keys: string[];
      /**
       * Rows changed only in the columns of the column plans that matched
       * them, and up to 20 of their keys.
       */
      columnRows: number;
      columnKeys: string[];
      plans: PlannedRowsPlan[];
    }[];
  };
  /**
   * Order edges to another area's step this tree doesn't have, each as
   * "<step> <field> <id>".
   */
  readonly unresolvedEdges: string[];
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

/** Every plan of planned rows, each with its table. */
function plansOf(report: RunReport): (PlannedRowsPlan & { table: string })[] {
  return report.tables.plannedRows.flatMap((p) =>
    p.plans.map((plan) => ({ ...plan, table: p.table }))
  );
}

/** The first lines of a report: what ran and the verdict. */
export function headline(report: RunReport): string[] {
  const total = COUNT_ORDER.reduce((n, c) => n + report.classes[c], 0);
  const classes = COUNT_ORDER.map(
    (c) => `${c.toLowerCase()} ${report.classes[c]}`
  ).join(', ');
  const rebuilt = report.tables.rebuilt.length;
  const differing = report.tables.diffs.filter((d) => !d.same).length;
  const failed = report.steps.filter((s) => s.exitCode !== 0).length;
  const leftOut = report.tables.ownedColumnsLeftOut.length;
  const unanswered = (report.probes.unanswered ?? []).length;
  const planned = report.tables.plannedRows.reduce((n, p) => n + p.rows, 0);
  const plannedColumns = report.tables.plannedRows.reduce(
    (n, p) => n + p.columnRows,
    0
  );
  const overdue = overdueLine(report.tables.exemptUntil, plansOf(report));
  const provisional = Object.entries(report.sources)
    .filter(([, info]) => info.provisional)
    .map(([name]) => name);
  return [
    `${report.scope}, mark ${report.mark}${report.final ? ', final' : ''}, backend ${report.backendHead ?? 'unknown'}: ${report.verdict}`,
    `tables ${total}: ${classes}; rebuilt ${rebuilt}, pending ${report.pending.length}, planned ${report.planned.length}, differing ${differing}${leftOut ? `; owned columns left out ${leftOut}` : ''}${planned ? `; planned rows missing ${planned}` : ''}${plannedColumns ? `; rows changed only in planned columns ${plannedColumns}` : ''}`,
    report.probes.stoppedBefore === null
      ? `probes ${report.probes.calls}: differ ${report.probes.differences.length}${unanswered ? `, not answered ${unanswered}` : ''}, unproven ${report.probes.unproven.length}; INDEX tables no probe read ${report.probes.unreadTables.length}`
      : `probes ${report.probes.calls}: not compared: the run stopped before pass B (${report.probes.stoppedBefore})`,
    `GET routes ${report.routes.documented}: probed ${report.routes.probed}, waived ${report.routes.waived}, open ${report.routes.open.length}`,
    `steps ${report.steps.length}: failed ${failed}; source violations ${report.violations.length}; provisional sources ${provisional.length ? provisional.join(', ') : 'none'}; unresolved cross-area edges ${report.unresolvedEdges.length}`,
    // Seen on every run, not left in the body.
    ...(overdue ? [overdue] : [])
  ];
}

/** A column plan's differing rows per column, as " (a 2, b 1)". */
function byColumn(plan: PlannedRowsPlan): string {
  const counts = Object.entries(plan.differingByColumn ?? {});
  return counts.length
    ? ` (${counts.map(([column, n]) => `${column} ${n}`).join(', ')})`
    : '';
}

/** After an `until` day the run is past. */
function overdueNote(dated: { overdue: boolean }): string {
  return dated.overdue ? ' (overdue: its last day has passed)' : '';
}

/**
 * Under a table that differs: each changed row's key with the names of the
 * columns that changed (never their values), and how many more there are.
 */
function changedColumnLines(diff: TableDiff): string {
  const rows = diff.changedColumns ?? [];
  if (!rows.length) return '';
  const more = (diff.changedRows ?? rows.length) - rows.length;
  return [
    ...rows.map(
      (r) => `  - ${r.key}: ${r.columns.join(', ') || 'columns not known'}`
    ),
    ...(more > 0 ? [`  - and ${more} more changed rows, not listed`] : [])
  ]
    .map((line) => `\n${line}`)
    .join('');
}

function section(title: string, lines: string[]): string[] {
  return lines.length ? ['', `## ${title}`, '', ...lines] : [];
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** The area table; with `compared` false, differences and unproven are unknown. */
function areaTable(areas: readonly AreaSummary[], compared: boolean): string[] {
  if (!areas.length) return [];
  const known = (n: number) => (compared ? String(n) : '-');
  return [
    '| Area | Tables | INDEX | Seeded | Kept | Rebuilt | Pending | Probes | Differ | Unproven | Failed steps |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...areas.map(
      (l) =>
        `| ${l.area} | ${l.tables} | ${l.index} | ${l.seeded} | ${l.kept} | ${l.rebuilt} | ${l.pending} | ${l.probes} | ${known(l.differences)} | ${known(l.unproven)} | ${l.failedSteps} |`
    )
  ];
}

function sourceLines(sources: RunReport['sources']): string[] {
  return Object.entries(sources).map(([name, info]) => {
    const where = info.url ? ` at ${redactUrl(info.url)}` : '';
    const from = info.provenance ? `, from ${info.provenance}` : '';
    const flag = info.provisional
      ? ` (provisional: ${info.provisionalWhy ? `${info.provisionalWhy}; ` : ''}a final run fails on it)`
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
    ...section(
      'Areas',
      areaTable(report.areas, report.probes.stoppedBefore === null)
    ),
    ...section('Sources', sourceLines(report.sources)),
    ...section(
      'Steps',
      report.steps.map(
        (s) =>
          `- ${s.kind} ${s.id}${s.area ? ` (${s.area})` : ''}: exit ${s.exitCode}${s.timedOut ? ', timed out' : ''}, ${seconds(s.durationMs)}${s.guarded ? '' : ', no source guard'}${s.rowsWritten ? `, rows in its tables afterwards ${JSON.stringify(s.rowsWritten)}` : ''}. Log: ${s.log}`
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
      "Probes the API didn't answer",
      (report.probes.unanswered ?? []).map(
        (d) => `- ${d.id} (${d.area}): ${d.reason}`
      )
    ),
    ...section(
      'Probes answered on a second try',
      (report.probes.retried ?? []).map((id) => `- ${id}`)
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
            `- ${d.table}: ${d.rowsBefore} rows before, ${d.rowsAfter} after; missing ${d.missing.join(' ') || 'none'}; extra ${d.extra.join(' ') || 'none'}; changed ${d.changed.join(' ') || 'none'}${changedColumnLines(d)}`
        )
    ),
    ...section(
      'Columns the row comparison leaves out',
      report.tables.volatileColumns.map((v) => {
        if (v.where === undefined)
          return `- ${v.table}.${v.column}: ${v.reason}`;
        const scope = v.scope
          ? `: ${v.scope.before} of ${v.scope.rowsBefore} rows before, ${v.scope.after} of ${v.scope.rowsAfter} after${v.scope.oneSide ? `; ${v.scope.oneSide} matched on one side only, so compared there` : ''}`
          : '';
        return `- ${v.table}.${v.column}, only where ${v.where}${scope}: ${v.reason}`;
      })
    ),
    ...section(
      'Rows keyed by a declared row key',
      report.tables.rowKeys.map(
        (k) => `- ${k.table} by ${k.columns.join(', ')}`
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
      'EXEMPT tables exempt only until a day',
      report.tables.exemptUntil.map(
        (e) => `- ${e.table}: until ${e.until}${overdueNote(e)}; ${e.why}`
      )
    ),
    ...section(
      'Planned rows: seeded rows only a later change rebuilds',
      report.tables.plannedRows.flatMap((p) => [
        `- ${p.table}: ${p.rows} planned rows missing from the rebuild${p.keys.length ? `, keys ${p.keys.join(' ')}` : ''}${p.columnRows ? `; ${p.columnRows} rows changed only in planned columns, keys ${p.columnKeys.join(' ')}` : ''}`,
        ...p.plans.map(
          (plan) =>
            `  - planned by ${plan.step}${plan.columns ? `, columns ${plan.columns.join(', ')}` : ''}: seeded ${plan.seeded ?? 'not read'}, ${plan.columns ? `differing ${plan.differing ?? 'not compared'}${byColumn(plan)}, excused ${plan.excused ?? 'not compared'}, ` : ''}missing ${plan.missing ?? 'not compared'}; until ${plan.until}${overdueNote(plan)}, ${plan.change}; ${plan.reason}; where ${plan.where}`
        )
      ])
    ),
    ...section(
      'Unresolved cross-area order edges',
      report.unresolvedEdges.map((edge) => `- ${edge}`)
    ),
    ...section(
      'Owned columns left out: their owner does not run here',
      report.tables.ownedColumnsLeftOut.map(
        (o) => `- ${o.table}.${o.column}: ${o.owner}, ${o.why}`
      )
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
  const overdue = overdueLine(report.tables.exemptUntil, plansOf(report));
  const unanswered = (report.probes.unanswered ?? []).length;
  const notAnswered = unanswered ? `, not answered ${unanswered}` : '';
  return `- ${report.finishedAt} ${report.scope}: ${report.verdict}, rebuilt ${report.tables.rebuilt.length}, pending ${report.pending.length}, ${report.probes.stoppedBefore === null ? `probe differences ${report.probes.differences.length}${notAnswered}` : 'probes not compared'}, failures ${report.failures.length}${overdue ? `; ${overdue}` : ''}${report.unresolvedEdges.length ? `; unresolved cross-area edges ${report.unresolvedEdges.length}` : ''}. ${runDir}`;
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
