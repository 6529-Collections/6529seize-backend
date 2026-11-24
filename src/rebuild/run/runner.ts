import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import {
  AreaManifest,
  NeededTable,
  PlannedRows,
  RebuildContext,
  RebuildSource,
  RebuildStep,
  TableClass,
  TableEntry,
  validUntil
} from '@/rebuild/manifest.types';
import { checkRegistry, RegistryResult } from '@/rebuild/registry-check';
import { orderSeeds, orderSteps } from '@/rebuild/step-order';
import {
  columnWritesOf,
  partitionsOf,
  rowWrittenTables,
  writersOf,
  writtenTables
} from '@/rebuild/step-writes';
import {
  CodeTables,
  discoverCodeTables,
  LiveTable,
  liveSchemaTables
} from '@/rebuild/table-discovery';
import {
  ColumnGrant,
  dropUserStatement,
  stepGrantStatements,
  stepUserName
} from '@/rebuild/guard/db-grants';
import { readViolations, SourceViolation } from '@/rebuild/guard/source-guard';
import {
  childEnv,
  DbAccount,
  preflightProblems,
  protectedFlagNames
} from '@/rebuild/stack/child-env';
import {
  runChild,
  startChild,
  StartedChild
} from '@/rebuild/stack/child-process';
import {
  LocalMysqld,
  portOpen,
  startLocalMysqld
} from '@/rebuild/stack/local-mysqld';
import { MysqlAdmin, Row, writtenByMysql } from '@/rebuild/stack/mysql-admin';
import { acquireHomeLock } from '@/rebuild/stack/home-lock';
import { bundleApi } from '@/rebuild/stack/api-bundle';
import { STEP_SPEC_ENV, StepSpec } from '@/rebuild/run/step-spec';
import {
  diffAnswers,
  expandAll,
  ProbeAnswer,
  ProbeCall,
  ProbeDifference,
  runProbes
} from '@/rebuild/probes/probe-runner';
import {
  canonicalRow,
  changedKeys,
  diffSnapshots,
  goneRows,
  snapshotRows,
  snapshotTable,
  TableDiff,
  TableSnapshot
} from '@/rebuild/snapshot/table-snapshot';
import {
  KeptRead,
  AreaSummary,
  RunReport,
  SourceInfo,
  StepOutcome,
  writeReport
} from '@/rebuild/report/report';
import {
  readDocumentedRoutes,
  routeCoverage
} from '@/rebuild/report/route-coverage';
import {
  SourceSpecs,
  URL_SOURCES,
  UrlSource
} from '@/rebuild/sources/source-spec';
import { RunningSource } from '@/rebuild/sources/running-source';
import {
  seedFilesDir,
  startSources,
  stopSources
} from '@/rebuild/sources/start-sources';
import { judge, PlannedRowsPlan, WaitingStep } from '@/rebuild/run/verdict';
import { stepCodeIn } from '@/rebuild/step-code';
import {
  columnPlanDecision,
  columnPlanProblem,
  rowAndColumnPlanOverlap
} from '@/rebuild/run/column-plans';
import { exemptUntil, runDay } from '@/rebuild/run/exempt-until';
import { refusalsIn } from '@/rebuild/run/refusals';
import {
  ownedColumnProblems,
  unstableColumns
} from '@/rebuild/run/owned-columns';
import { waitForApi } from '@/rebuild/stack/api-ready';

/** A table's partition columns and every tuple its writers own. */
interface Partitions {
  readonly columns: readonly string[];
  readonly values: readonly (readonly string[])[];
}

/** An owned column the row comparison leaves out: its owner doesn't run. */
interface OwnedColumnLeftOut {
  readonly table: string;
  readonly column: string;
  readonly owner: string;
  /** Why the owner doesn't run: another area's, planned, or waiting. */
  readonly why: string;
}

export interface RunOptions {
  readonly repoRoot: string;
  /** Holds `mysql/`, `runs/` and `STATUS.md`. */
  readonly home: string;
  readonly manifests: readonly AreaManifest[];
  /** One area's tables only; null for the full run. */
  readonly area: string | null;
  readonly mark: 'head' | 'switch';
  /** The full proof: everything a run otherwise only notes fails it. */
  readonly final: boolean;
  readonly mysqlPort: number;
  /** 0 picks a free port. */
  readonly apiPort: number;
  readonly mysqldPath?: string;
  readonly sources: SourceSpecs;
  readonly chainHeight: number | null;
  readonly ethBlock: number | null;
  readonly log: (line: string) => void;
  /**
   * The run's day, YYYY-MM-DD, that `until` days are judged against; when
   * not given, the day the run started (UTC).
   */
  readonly today?: string;
}

/** A table's plans of planned rows, with each plan's keys and all of them. */
interface FoundPlans {
  /**
   * The key of every row a plan of whole rows matched, one per row, as
   * the snapshots key them: the rows that may be missing.
   */
  keys: string[];
  plans: {
    /** The manifest's plan. */
    entry: PlannedRows;
    /** What the report shows; the comparison fills in its counts. */
    plan: { -readonly [K in keyof PlannedRowsPlan]: PlannedRowsPlan[K] };
    /** The keys of the rows its condition matched, one per row. */
    keys: string[];
    /** A column plan's matched rows as seeded, by key. */
    rows: Map<string, Row> | null;
  }[];
}

const MAIN_DB = 'rebuild_main';
const KEPT_DB = 'rebuild_kept';
const APP_USER = 'rebuild_app';
const KEPT_CLASSES: ReadonlySet<TableClass> = new Set<TableClass>([
  'EPHEMERAL',
  'PROVIDER',
  'EXEMPT'
]);
const SCHEMA_TIMEOUT_MS = 20 * 60_000;
const API_READY_TIMEOUT_MS = 5 * 60_000;
/** The key the run gives the app for the ethereum source's Alchemy shim. */
const SHIM_ALCHEMY_KEY = 'rebuild';

function stamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

function secret(): string {
  return randomBytes(24).toString('hex');
}

function gitHead(repoRoot: string): string | null {
  const result = spawnSync(
    'git', // NOSONAR -- the developer's own git from PATH; no shell, and every argument is fixed.
    ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'],
    {
      encoding: 'utf8',
      windowsHide: true
    }
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

function endpointOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    const port =
      parsed.port ||
      (parsed.protocol === 'https:' || parsed.protocol === 'wss:'
        ? '443'
        : '80');
    return `${parsed.hostname}:${port}`;
  } catch {
    return null;
  }
}

/** A port nothing listens on now, chosen by the system. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Puts the run's source URLs into `{gateway}`-style placeholders. */
export function fillSourcePlaceholders(
  value: string,
  urls: Readonly<Record<string, string | null>>
): string {
  return value.replace(
    /\{(gateway|relays|ethereum|files)\}/g,
    (match, name) => urls[name] ?? match
  );
}

/** One run of the rebuild check. */
class RebuildRun {
  private readonly runDir: string;
  private readonly statusFile: string;
  private readonly violationsFile: string;
  private readonly jwtSecret = secret();
  private readonly appPassword = secret();
  private readonly scope: string;
  private readonly startedAt = new Date();
  private readonly failures: string[] = [];
  private readonly notes: string[] = [];
  private readonly steps: StepOutcome[] = [];
  private readonly stepPids = new Map<number, StepOutcome['kind']>();
  private server: LocalMysqld | null = null;
  private admin: MysqlAdmin | null = null;
  private mysqlVersion: string | null = null;
  private registry: RegistryResult | null = null;
  private live: LiveTable[] = [];
  private calls: ProbeCall[] = [];
  /** Probes that failed or whose passes differ. */
  private differences: ProbeDifference[] = [];
  /** Probes whose first answer was 4xx or carried no data. */
  private unproven: ProbeDifference[] = [];
  /** Whether pass B ran and the answers were compared. */
  private compared = false;
  private unreadTables: string[] = [];
  /** Planned steps skipped because their module isn't in this tree. */
  private plannedSteps: string[] = [];
  /** Steps skipped as planned because a table they need isn't in the schema. */
  private waitingSteps: WaitingStep[] = [];
  /** Needs on tables the schema has: the step runs, and the need can go. */
  private staleNeeds: string[] = [];
  /** The fresh schema's base tables. */
  private baseTables: ReadonlySet<string> = new Set();
  /** Planned probes held because a table they need isn't in the schema. */
  private heldProbes: string[] = [];
  /** Tables only a skipped planned rebuilder writes: kept like pending ones. */
  private plannedWrites = new Set<string>();
  /** Rows in each INDEX table of the schema after the seeds ran. */
  private seededRows: Record<string, number> = {};
  /** Partitioned tables with rows no writer's partition owns, after the seeds. */
  private unownedRows: string[] = [];
  /** The run's day, that `until` days are judged against. */
  private readonly day = this.o.today ?? runDay(this.startedAt);
  /** EXEMPT tables exempt only until a day, against the run's day. */
  private readonly exemptTablesUntil = exemptUntil(this.o.manifests, this.day);
  /**
   * Whether each step's code is in this tree, decided once at the start:
   * a module that appears while the run goes doesn't make a step left out
   * of the order check run.
   */
  private readonly codeHere: ReadonlyMap<RebuildStep, boolean> = new Map(
    this.o.manifests
      .flatMap((m) => [...m.seeds, ...m.rebuilders])
      .map((step) => [step, stepCodeIn(this.o.repoRoot)(step)])
  );
  /** By the step itself: a seed and a rebuilder may not share an id. */
  private readonly stepCodeHere = (step: RebuildStep): boolean => {
    const here = this.codeHere.get(step);
    if (here === undefined) {
      throw new Error(
        `step ${step.id} is not one of the run's manifests' steps`
      );
    }
    return here;
  };
  /**
   * Owned columns this run doesn't rebuild, because their owner is outside
   * the area or skipped: left out of the row comparison.
   */
  private unrunOwnedColumns: OwnedColumnLeftOut[] = [];
  /**
   * The running rebuilders' plans of seeded rows only a later change
   * rebuilds, by table.
   */
  private plannedRows = new Map<string, FoundPlans>();
  private tableDiffs: TableDiff[] = [];
  private notEmptyAfterDrop: string[] = [];
  private rebuiltTables: string[] = [];
  private apiPort = 0;
  private releaseLock: (() => void) | null = null;
  private running: RunningSource[] = [];
  private apiBundlePath: string | null = null;

  constructor(private readonly o: RunOptions) {
    this.scope = o.area ? `area-${o.area}` : 'full';
    this.runDir = path.resolve(
      o.home,
      'runs',
      `${stamp(this.startedAt)}-${this.scope}`
    );
    this.statusFile = path.resolve(o.home, 'STATUS.md');
    this.violationsFile = path.join(this.runDir, 'violations.jsonl');
  }

  private get scopeManifests(): AreaManifest[] {
    return this.o.manifests.filter(
      (m) => !this.o.area || m.area === this.o.area
    );
  }

  private entries(): Map<string, { area: string; entry: TableEntry }> {
    const result = new Map<string, { area: string; entry: TableEntry }>();
    for (const manifest of this.o.manifests) {
      for (const [table, entry] of Object.entries(manifest.tables)) {
        result.set(table, { area: manifest.area, entry });
      }
    }
    return result;
  }

  private sourceUrl(name: UrlSource): string | null {
    return this.running.find((source) => source.name === name)?.url ?? null;
  }

  private sourceUrls(): Record<RebuildSource, string | null> {
    return {
      gateway: this.sourceUrl('gateway'),
      relays: this.sourceUrl('relays'),
      ethereum: this.sourceUrl('ethereum'),
      files: this.sourceUrl('files'),
      repo: null
    };
  }

  private allowedEndpoints(): string {
    const endpoints = [`127.0.0.1:${this.o.mysqlPort}`];
    for (const source of this.running) {
      const endpoint = endpointOf(source.url);
      if (endpoint) endpoints.push(endpoint);
    }
    return endpoints.join(',');
  }

  /** The ethereum source as the app's RPC and Alchemy endpoints. */
  private ethereumEnv(): Record<string, string> {
    const url = this.sourceUrl('ethereum');
    return url
      ? {
          ETHEREUM_RPC_URL: url,
          ALCHEMY_BASE_URL: url,
          ALCHEMY_API_KEY: SHIM_ALCHEMY_KEY
        }
      : {};
  }

  private sourceInfo(): Record<string, SourceInfo> {
    const info: Record<string, SourceInfo> = {};
    for (const name of URL_SOURCES) {
      info[name] = this.running.find((s) => s.name === name)?.info ?? {
        url: null,
        mode: 'none',
        provenance: null,
        provisional: false
      };
    }
    info.repo = {
      url: null,
      mode: 'local',
      provenance: 'files in this repository',
      provisional: false
    };
    return info;
  }

  private allFlags(): Record<string, string> {
    const flags: Record<string, string> = {};
    for (const manifest of this.o.manifests) {
      for (const [name, value] of Object.entries(manifest.flags)) {
        if (name in flags && flags[name] !== value) {
          this.failures.push(
            `Flag ${name} is ${flags[name]} in one manifest and ${value} in ${manifest.area}`
          );
        }
        flags[name] = value;
      }
    }
    return flags;
  }

  /**
   * A child's environment: `flags` (an area's, checked and with source
   * placeholders filled) under the run's own variables and `own`.
   */
  private env(
    db: DbAccount,
    flags: Readonly<Record<string, string>>,
    own: Readonly<Record<string, string>> = {}
  ): Record<string, string> {
    const sources = this.sourceUrls();
    const sourceEnv: Record<string, string> = {};
    for (const name of URL_SOURCES) {
      sourceEnv[`REBUILD_SOURCE_${name.toUpperCase()}`] = sources[name] ?? '';
    }
    const refused = protectedFlagNames(flags);
    if (refused.length) {
      throw new Error(
        `An area's flags may not set the run's own variables: ${refused.join(', ')}`
      );
    }
    const filled: Record<string, string> = {};
    for (const [name, value] of Object.entries(flags)) {
      filled[name] = fillSourcePlaceholders(value, sources);
    }
    // The run's own settings come last, so no flag can replace them.
    return childEnv({
      parent: process.env,
      home: path.resolve(this.o.home),
      db,
      jwtSecret: this.jwtSecret,
      extra: {
        ...filled,
        REBUILD_VIOLATIONS_FILE: this.violationsFile,
        REBUILD_ALLOWED_ENDPOINTS: this.allowedEndpoints(),
        REBUILD_MARK: this.o.mark,
        REBUILD_CHAIN_HEIGHT: this.o.chainHeight?.toString() ?? '',
        REBUILD_ETH_BLOCK: this.o.ethBlock?.toString() ?? '',
        ...sourceEnv,
        ...this.ethereumEnv(),
        ...own
      }
    });
  }

  private appAccount(): DbAccount {
    return {
      host: '127.0.0.1',
      port: this.o.mysqlPort,
      user: APP_USER,
      password: this.appPassword,
      database: MAIN_DB
    };
  }

  private record(outcome: StepOutcome, pid: number | null): StepOutcome {
    this.steps.push(outcome);
    if (pid !== null) this.stepPids.set(pid, outcome.kind);
    if (outcome.exitCode !== 0) {
      this.failures.push(
        `${outcome.kind} ${outcome.id} ${outcome.timedOut ? 'timed out' : `exited with ${outcome.exitCode}`}; see ${outcome.log}`
      );
    }
    return outcome;
  }

  private async buildSchema(label: string): Promise<boolean> {
    this.o.log(`building the schema from code (${label})`);
    const result = await runChild({
      label,
      repoRoot: this.o.repoRoot,
      entry: path.join('src', 'rebuild', 'stack', 'build-schema.child.ts'),
      env: this.env(this.appAccount(), {}),
      logFile: path.join(this.runDir, 'logs', `${label}.log`),
      timeoutMs: SCHEMA_TIMEOUT_MS
    });
    const outcome = this.record(
      {
        kind: 'schema',
        id: label,
        area: null,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        log: result.logFile,
        guarded: true
      },
      result.pid
    );
    return outcome.exitCode === 0;
  }

  private async runStep(
    kind: 'seed' | 'rebuilder',
    area: AreaManifest,
    step: RebuildStep
  ): Promise<boolean> {
    const admin = this.admin!;
    const liveNames = new Set(this.live.map((t) => t.name));
    const baseNames = new Set(
      this.live.filter((t) => t.type === 'BASE TABLE').map((t) => t.name)
    );
    let account = this.appAccount();
    let user: string | null = null;
    if (kind === 'rebuilder') {
      user = stepUserName(step.id);
      const password = secret();
      await admin.run(
        stepGrantStatements({
          user,
          password,
          database: MAIN_DB,
          writes: writtenTables(step).filter((t) => baseNames.has(t)),
          reads: (step.reads ?? []).filter((t) => liveNames.has(t)),
          columns: await this.columnGrants(step, baseNames)
        })
      );
      account = { ...account, user, password };
    }
    // A partitioned rebuilder may change only its own rows: the rest of
    // the table must come out as it went in.
    const outside =
      kind === 'rebuilder'
        ? await this.outsideDigests(step, baseNames)
        : new Map<string, string>();
    // A column owner may change only its columns of existing rows.
    const unowned =
      kind === 'rebuilder'
        ? await this.unownedDigests(step, baseNames)
        : new Map<string, string>();
    const context: RebuildContext = {
      area: area.area,
      stepId: step.id,
      sources: this.sourceUrls(),
      seedFilesDir:
        kind === 'seed' && this.sourceUrl('files')
          ? seedFilesDir(this.runDir)
          : null,
      mark: {
        name: this.o.mark,
        chainHeight: this.o.chainHeight,
        ethBlock: this.o.ethBlock
      }
    };
    const own: Record<string, string> = {
      REBUILD_AREA: area.area,
      REBUILD_STEP_ID: step.id
    };
    const label = `${kind}-${step.id}`.replace(/[^A-Za-z0-9._-]/g, '_');
    const common = {
      label,
      repoRoot: this.o.repoRoot,
      logFile: path.join(this.runDir, 'logs', `${label}.log`),
      timeoutMs: step.timeoutMinutes * 60_000
    };
    let guarded = true;
    let result;
    if ('module' in step.run) {
      const spec: StepSpec = {
        repoRoot: this.o.repoRoot,
        module: step.run.module,
        exportName: step.run.exportName,
        context
      };
      result = await runChild({
        ...common,
        entry: path.join('src', 'rebuild', 'run', 'step.child.ts'),
        env: this.env(account, area.flags, {
          ...own,
          [STEP_SPEC_ENV]: JSON.stringify(spec)
        })
      });
    } else {
      guarded = /(^|[\\/])node(\.exe)?$/i.test(step.run.command[0]);
      result = await runChild({
        ...common,
        command: step.run.command,
        env: this.env(account, area.flags, {
          ...own,
          REBUILD_CONTEXT: JSON.stringify(context)
        })
      });
    }
    if (user) await admin.query(dropUserStatement(user));
    const unownedAfter = await this.unownedDigests(step, baseNames);
    unowned.forEach((digest, table) => {
      if (unownedAfter.get(table) !== digest) {
        this.failures.push(
          `column owner ${step.id} changed rows of ${table}, or columns it doesn't own`
        );
      }
    });
    if (result.exitCode !== 0) {
      let log = '';
      try {
        log = fs.readFileSync(result.logFile, 'utf8');
      } catch {
        log = '';
      }
      this.failures.push(...refusalsIn(step, log));
    }
    const outsideAfter = await this.outsideDigests(step, baseNames);
    outside.forEach((digest, table) => {
      if (outsideAfter.get(table) !== digest) {
        this.failures.push(
          `rebuilder ${step.id} changed rows of ${table} outside its partition`
        );
      }
    });
    const rowsWritten: Record<string, number> = {};
    for (const table of writtenTables(step).filter((t) => baseNames.has(t))) {
      rowsWritten[table] = await admin.rowCount(MAIN_DB, table);
    }
    const outcome = this.record(
      {
        kind,
        id: step.id,
        area: area.area,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        log: result.logFile,
        rowsWritten,
        guarded
      },
      result.pid
    );
    return outcome.exitCode === 0;
  }

  private async runSteps(
    kind: 'seed' | 'rebuilder',
    manifests: readonly AreaManifest[]
  ): Promise<boolean> {
    const areaOf = new Map<string, AreaManifest>();
    const all: RebuildStep[] = [];
    for (const manifest of manifests) {
      for (const step of kind === 'seed'
        ? manifest.seeds
        : manifest.rebuilders) {
        areaOf.set(step.id, manifest);
        all.push(step);
      }
    }
    const order = kind === 'seed' ? orderSeeds(all) : orderSteps(all);
    for (const step of order.order) {
      if (!this.stepCodeHere(step)) {
        this.o.log(`${kind} ${step.id}: planned, its module is not here`);
        this.plannedSteps.push(step.id);
        continue;
      }
      const missing = this.missingNeeds(step);
      if (missing.length) {
        this.o.log(
          `${kind} ${step.id}: planned, it needs ${missing
            .map((need) => need.table)
            .join(', ')}, not in the schema`
        );
        missing.forEach((need) =>
          this.waitingSteps.push({ step: step.id, ...need })
        );
        continue;
      }
      this.o.log(`${kind} ${step.id}`);
      if (!(await this.runStep(kind, areaOf.get(step.id)!, step))) return false;
      if (kind === 'rebuilder') await this.rowWriterDone(step);
    }
    return true;
  }

  /**
   * For each kept table that rebuilders running here write by partition,
   * those writers' partitions. A table with a writer of the whole table
   * running here is never kept beside a partition writer: the registry
   * refuses the pair.
   */
  private runningPartitionsOf(
    kept: readonly string[]
  ): Map<string, Partitions> {
    const keptSet = new Set(kept);
    const running = this.partitionedTables(
      this.scopeManifests
        .flatMap((m) => m.rebuilders)
        .filter((step) => this.stepRunsHere(step))
    );
    return new Map(Array.from(running).filter(([table]) => keptSet.has(table)));
  }

  /**
   * The partitions of tables every writer writes in part: the column and
   * each writer's values. Tables with a whole writer are left out (the
   * registry refuses them beside a partition).
   */
  private partitionedTables(
    rebuilders: readonly RebuildStep[]
  ): Map<string, Partitions> {
    const result = new Map<string, Partitions>();
    writersOf(rebuilders).forEach((writers, table) => {
      // Rows only: a column owner writes no rows of its own.
      const partitions = writers
        .filter((w) => !w.columns)
        .map((w) => w.partition);
      if (!partitions.length || partitions.some((p) => p === null)) return;
      result.set(table, {
        columns: partitions[0]!.columns,
        values: partitions.flatMap((p) => p!.values)
      });
    });
    return result;
  }

  /**
   * Every column owner of each table, over every area's rebuilders.
   */
  private columnOwners(): Map<
    string,
    { step: string; columns: readonly string[] }[]
  > {
    const owners = new Map<
      string,
      { step: string; columns: readonly string[] }[]
    >();
    writersOf(this.o.manifests.flatMap((m) => m.rebuilders)).forEach(
      (writers, table) => {
        const list = writers
          .filter((w) => w.columns)
          .map((w) => ({ step: w.step, columns: w.columns! }));
        if (list.length) owners.set(table, list);
      }
    );
    return owners;
  }

  /**
   * The grants that hold a step to its columns: a column owner reads the
   * table and updates only its columns; a row writer of a table with column
   * owners inserts every column (its live insert may carry values into the
   * owned ones, which the run resets before the owners run), updates every
   * other column, and deletes rows.
   */
  private async columnGrants(
    step: RebuildStep,
    baseNames: ReadonlySet<string>
  ): Promise<ColumnGrant[]> {
    const owners = this.columnOwners();
    const grants: ColumnGrant[] = [];
    for (const owned of columnWritesOf(step)) {
      if (!baseNames.has(owned.table)) continue;
      grants.push({
        table: owned.table,
        insert: [],
        update: owned.columns,
        delete: false
      });
    }
    for (const table of rowWrittenTables(step)) {
      const owned = (owners.get(table) ?? []).flatMap((o) => o.columns);
      if (!owned.length || !baseNames.has(table)) continue;
      const insertable = await this.admin!.insertableColumns(MAIN_DB, table);
      const free = insertable.filter((column) => !owned.includes(column));
      grants.push({ table, insert: insertable, update: free, delete: true });
    }
    return grants;
  }

  /**
   * For each table a step owns columns of: a digest of its rows without
   * those columns (the row set and every other column), the same whatever
   * order MySQL returns them in.
   */
  private async unownedDigests(
    step: RebuildStep,
    baseNames: ReadonlySet<string>
  ): Promise<Map<string, string>> {
    const digests = new Map<string, string>();
    for (const { table, columns } of columnWritesOf(step)) {
      if (!baseNames.has(table)) continue;
      const rows = await this.admin!.orderedRows(MAIN_DB, table, []);
      // MySQL itself changes an ON UPDATE or generated column when the
      // owner updates a row: not the owner's change.
      const skip = new Set([
        ...columns,
        ...(await this.admin!.columnInfo(MAIN_DB, table))
          .filter(writtenByMysql)
          .map((column) => column.name)
      ]);
      const hashes = rows
        .map((row) =>
          createHash('sha256').update(canonicalRow(row, skip)).digest('hex')
        )
        .sort((a, b) => (a < b ? -1 : Number(a > b)));
      digests.set(
        table,
        createHash('sha256').update(hashes.join('\n')).digest('hex')
      );
    }
    return digests;
  }

  /**
   * Tables a running column owner writes whose row writer doesn't run
   * here (another area's, or a skipped step), with the columns those
   * owners own: their rows stay, and only those columns are rebuilt.
   */
  private ownedOnlyTables(): Map<string, string[]> {
    const running = this.scopeManifests
      .flatMap((m) => m.rebuilders)
      .filter((step) => this.stepRunsHere(step));
    const rowTables = new Set(running.flatMap(rowWrittenTables));
    const result = new Map<string, string[]>();
    for (const step of running) {
      for (const { table, columns } of columnWritesOf(step)) {
        if (rowTables.has(table) || !this.rebuiltTables.includes(table)) {
          continue;
        }
        result.set(table, [...(result.get(table) ?? []), ...columns]);
      }
    }
    return result;
  }

  /**
   * For each table with column owners whose rows this run rebuilds: the
   * row writers that run here and haven't yet, the running owners'
   * columns to reset once they have, and the absent owners' columns saved
   * before the drop to put back. Set in the drop.
   */
  private ownedAfterRows = new Map<
    string,
    {
      waiting: Set<string>;
      reset: string[];
      restore: string[];
      saved: string | null;
    }
  >();

  /**
   * Before the drop: for each rebuilt table with column owners, what its
   * row writers leave to them, and the absent owners' columns saved (with
   * the key) for tables whose rows the run rewrites.
   */
  private async planOwnedColumns(): Promise<void> {
    const running = this.scopeManifests
      .flatMap((m) => m.rebuilders)
      .filter((step) => this.stepRunsHere(step));
    for (const [table, owners] of Array.from(this.columnOwners())) {
      if (!this.rebuiltTables.includes(table)) continue;
      const runningIds = new Set(running.map((step) => step.id));
      const waiting = new Set(
        running
          .filter((step) => rowWrittenTables(step).includes(table))
          .map((step) => step.id)
      );
      const reset = owners
        .filter((owner) => runningIds.has(owner.step))
        .flatMap((owner) => owner.columns);
      const restore = this.unrunOwnedColumns
        .filter((owned) => owned.table === table)
        .map((owned) => owned.column);
      let saved: string | null = null;
      if (restore.length && waiting.size) {
        saved = `owned_${createHash('sha256').update(table).digest('hex').slice(0, 24)}`;
        await this.admin!.saveColumns(
          MAIN_DB,
          table,
          await this.admin!.primaryKey(MAIN_DB, table),
          restore,
          KEPT_DB,
          saved
        );
      }
      this.ownedAfterRows.set(table, { waiting, reset, restore, saved });
    }
  }

  /**
   * Once a table's running row writers are done (or at the drop's end when
   * none runs): the absent owners' columns go back where their rows'
   * keys still are, and the running owners' columns are reset on every
   * row, so they fill them again whatever the row writer, the kept copy or
   * another area left there.
   */
  private async afterRowWriters(table: string): Promise<void> {
    const plan = this.ownedAfterRows.get(table);
    if (!plan) return;
    const admin = this.admin!;
    if (plan.saved) {
      await admin.restoreColumns(
        MAIN_DB,
        table,
        await admin.primaryKey(MAIN_DB, table),
        plan.restore,
        KEPT_DB,
        plan.saved
      );
    }
    if (plan.reset.length) {
      const info = await admin.columnInfo(MAIN_DB, table);
      await admin.resetColumns(
        MAIN_DB,
        table,
        info.filter((column) => plan.reset.includes(column.name))
      );
    }
    this.ownedAfterRows.delete(table);
  }

  /** After a rebuilder: the tables whose last running row writer it was. */
  private async rowWriterDone(step: RebuildStep): Promise<void> {
    for (const table of rowWrittenTables(step)) {
      const plan = this.ownedAfterRows.get(table);
      if (!plan || !plan.waiting.delete(step.id) || plan.waiting.size) continue;
      await this.afterRowWriters(table);
    }
  }

  /**
   * At run start: exempt columns must be there, and each table's column
   * owners must be able to run (see ownedColumnProblems).
   */
  private async ownedColumnsExist(): Promise<boolean> {
    const problems: string[] = [];
    for (const [table, { entry }] of Array.from(this.entries())) {
      if (!entry.exemptColumns?.length || !this.baseTables.has(table)) continue;
      const names = new Set(await this.admin!.columnNames(MAIN_DB, table));
      for (const { column } of entry.exemptColumns) {
        if (!names.has(column)) {
          problems.push(
            `${table}.${column} is exempt, but the schema doesn't have it`
          );
        }
      }
    }
    const entries = this.entries();
    for (const [table, owners] of Array.from(this.columnOwners())) {
      if (!this.baseTables.has(table)) continue;
      problems.push(
        ...ownedColumnProblems({
          table,
          owners,
          columns: await this.admin!.columnInfo(MAIN_DB, table),
          primaryKey: await this.admin!.primaryKey(MAIN_DB, table),
          volatile: unstableColumns(entries.get(table)?.entry)
        })
      );
    }
    this.failures.push(...problems);
    return problems.length === 0;
  }

  /**
   * For each table a rebuilder writes in part: a digest of the rows outside
   * its partition, the same whatever order MySQL returns them in.
   */
  private async outsideDigests(
    step: RebuildStep,
    baseNames: ReadonlySet<string>
  ): Promise<Map<string, string>> {
    const digests = new Map<string, string>();
    for (const { table, partition } of partitionsOf(step)) {
      if (!baseNames.has(table)) continue;
      const rows = await this.admin!.partitionRows(
        MAIN_DB,
        table,
        partition.columns,
        partition.values,
        false
      );
      const hashes = rows
        .map((row) =>
          createHash('sha256').update(canonicalRow(row)).digest('hex')
        )
        .sort((a, b) => (a < b ? -1 : Number(a > b)));
      digests.set(
        table,
        createHash('sha256').update(hashes.join('\n')).digest('hex')
      );
    }
    return digests;
  }

  /**
   * Partitioned tables holding rows no writer's partition owns after the
   * seeds: rows no rebuilder rebuilds.
   */
  private async findUnownedRows(base: ReadonlySet<string>): Promise<string[]> {
    const found: string[] = [];
    const partitioned = this.partitionedTables(
      this.o.manifests.flatMap((m) => m.rebuilders)
    );
    for (const [table, { columns, values }] of Array.from(partitioned)) {
      if (!base.has(table)) continue;
      const rows = await this.admin!.partitionRowCount(
        MAIN_DB,
        table,
        columns,
        values,
        false
      );
      if (rows) {
        found.push(
          `${table} (${rows} rows whose (${columns.join(', ')}) is in no writer's partition)`
        );
      }
    }
    return found;
  }

  /**
   * MySQL decides whether two partitions' tuples are one value: before the
   * seeds, every pair of tuples from different writers of a table is
   * compared under its columns' own collations, and any equal pair fails
   * the run (the registry's fold is only an early warning).
   */
  private async partitionsDisjointInMysql(): Promise<boolean> {
    const problems: string[] = [];
    const writers = writersOf(this.o.manifests.flatMap((m) => m.rebuilders));
    for (const [table, writers_] of Array.from(writers)) {
      const list = writers_.filter((w) => !w.columns);
      if (list.length < 2 || list.some((w) => !w.partition)) continue;
      if (!this.baseTables.has(table)) continue;
      // By step id, so a report names the pair the same way every run.
      const sorted = [...list].sort((x, y) =>
        x.step < y.step ? -1 : Number(x.step > y.step)
      );
      const columns = sorted[0].partition!.columns;
      for (let i = 0; i < sorted.length; i++) {
        for (const other of sorted.slice(i + 1)) {
          const a = sorted[i].partition!.values;
          const b = other.partition!.values;
          let overlaps: [number, number][];
          try {
            overlaps = await this.admin!.overlappingTuples(
              MAIN_DB,
              table,
              columns,
              a,
              b
            );
          } catch (error) {
            problems.push(
              `${table}'s partitions can't be compared in MySQL: ${String(error)}`
            );
            continue;
          }
          for (const [x, y] of overlaps) {
            problems.push(
              `${table}'s partitions overlap under its collation: ${sorted[i].step}'s (${a[x].join(', ')}) and ${other.step}'s (${b[y].join(', ')})`
            );
          }
        }
      }
    }
    this.failures.push(...problems);
    return problems.length === 0;
  }

  /**
   * A checkpoint column must exist and be NOT NULL, or its MAX may not be
   * the row the table's readers take.
   */
  private async checkpointColumnsHold(): Promise<boolean> {
    const entries = this.entries();
    const problems: string[] = [];
    for (const [table, { entry }] of Array.from(entries)) {
      const checkpoint = entry.checkpoint;
      if (!checkpoint || !this.baseTables.has(table)) continue;
      const nullable = await this.admin!.columnNullable(
        MAIN_DB,
        table,
        checkpoint.column
      );
      if (nullable === null) {
        problems.push(`${table} has no checkpoint column ${checkpoint.column}`);
      } else if (nullable) {
        problems.push(
          `${table}'s checkpoint column ${checkpoint.column} may hold NULL`
        );
      }
    }
    this.failures.push(...problems);
    return problems.length === 0;
  }

  /**
   * Needs, of the steps this run runs (every area's seeds, and the
   * scope's rebuilders), on tables the schema already has: they no longer
   * hold anything back and should be dropped.
   */
  private findStaleNeeds(base: ReadonlySet<string>): string[] {
    return [
      ...this.o.manifests.flatMap((m) => m.seeds),
      ...this.scopeManifests.flatMap((m) => m.rebuilders)
    ].flatMap((step) =>
      (step.needs ?? [])
        .filter((need) => base.has(need.table))
        .map(
          (need) =>
            `${step.id} needs ${need.table}, which the schema now has: drop the need`
        )
    );
  }

  /** The tables a step needs that the fresh schema doesn't have. */
  private missingNeeds(step: RebuildStep): NeededTable[] {
    return (step.needs ?? []).filter(
      (need) => !this.baseTables.has(need.table)
    );
  }

  /** Whether a step runs here: its code is here and its tables are. */
  private stepRunsHere(step: RebuildStep): boolean {
    return this.stepCodeHere(step) && this.missingNeeds(step).length === 0;
  }

  /** The API bundled once per run, as its deploy bundles it. */
  private async apiBundle(): Promise<string> {
    if (!this.apiBundlePath) {
      this.o.log('bundling the API');
      this.apiBundlePath = await bundleApi(
        this.o.repoRoot,
        path.join(path.resolve(this.o.home), 'api')
      );
    }
    return this.apiBundlePath;
  }

  private async startApi(
    flags: Record<string, string>,
    label: string
  ): Promise<StartedChild | null> {
    if (await portOpen(this.apiPort)) {
      this.failures.push(
        `Port ${this.apiPort} for the API is in use; choose another with --api-port`
      );
      return null;
    }
    const logFile = path.join(this.runDir, 'logs', `${label}.log`);
    const child = startChild({
      label,
      repoRoot: this.o.repoRoot,
      command: [
        process.execPath,
        '--enable-source-maps',
        await this.apiBundle()
      ],
      guardLoaded: true,
      cwd: path.dirname(await this.apiBundle()),
      env: this.env(this.appAccount(), flags, {
        REBUILD_API_PORT: String(this.apiPort)
      }),
      logFile,
      timeoutMs: API_READY_TIMEOUT_MS
    });
    if (child.pid !== null) this.stepPids.set(child.pid, 'api');
    let exited: number | null | undefined;
    void child.exited.then((code) => (exited = code));
    const started = Date.now();
    const ready = await waitForApi({
      answers: () =>
        fetch(`http://127.0.0.1:${this.apiPort}/health`)
          .then(() => true)
          .catch(() => false),
      ended: () => exited !== undefined,
      timeoutMs: API_READY_TIMEOUT_MS,
      pauseMs: 1000
    });
    if (ready) return child;
    await child.stop();
    // An API that never answered fails the run, even if it exited with 0:
    // otherwise a run could pass with no probe answered.
    this.failures.push(
      `The API (${label}) never answered /health; see ${logFile}`
    );
    this.record(
      {
        kind: 'api',
        id: label,
        area: null,
        exitCode: exited ?? null,
        timedOut: exited === undefined,
        durationMs: Date.now() - started,
        log: logFile,
        guarded: true
      },
      child.pid
    );
    return null;
  }

  private async probePass(
    pass: 'a' | 'b',
    flags: Record<string, string>
  ): Promise<Record<string, ProbeAnswer> | null> {
    if (!this.calls.length) return {};
    const admin = this.admin!;
    if (pass === 'a') await admin.resetTableIo();
    const api = await this.startApi(flags, `api-${pass}`);
    if (!api) return null;
    try {
      this.o.log(`probe pass ${pass}: ${this.calls.length} calls`);
      const answers = await runProbes(
        `http://127.0.0.1:${this.apiPort}`,
        this.calls,
        this.jwtSecret
      );
      fs.writeFileSync(
        path.join(this.runDir, `answers-${pass}.json`),
        `${JSON.stringify(answers, null, 2)}\n`
      );
      return answers;
    } finally {
      await api.stop();
    }
  }

  private async findUnreadTables(): Promise<void> {
    const io = this.calls.length ? await this.admin!.tableIo(MAIN_DB) : {};
    const waived = new Set(
      this.o.manifests.flatMap((m) =>
        (m.waivers?.unprobedTables ?? []).map((w) => w.target)
      )
    );
    this.unreadTables = this.rebuiltTables.filter(
      (t) => !waived.has(t) && !(io[t]?.reads > 0)
    );
  }

  /** The columns the row comparison leaves out of a table. */
  private volatileOf(table: string): string[] {
    const entry = this.entries().get(table)?.entry;
    return [
      ...(entry?.volatileColumns ?? []).map((c) => c.column),
      ...(entry?.exemptColumns ?? []).map((c) => c.column),
      ...this.unrunOwnedColumns
        .filter((owned) => owned.table === table)
        .map((owned) => owned.column)
    ];
  }

  private async snapshots(
    tables: readonly string[]
  ): Promise<Map<string, TableSnapshot>> {
    const entries = this.entries();
    const result = new Map<string, TableSnapshot>();
    for (const table of tables) {
      result.set(
        table,
        await snapshotTable(
          this.admin!,
          MAIN_DB,
          table,
          this.volatileOf(table),
          entries.get(table)?.entry.checkpoint?.column
        )
      );
    }
    return result;
  }

  /**
   * The seeded rows the running rebuilders plan (`plannedRows`): each
   * plan's `where` on the seeded tables, keyed as the snapshots key the
   * rows. A condition MySQL can't evaluate fails the run, and so does a
   * planned row in another running writer's partition: a plan covers only
   * rows its own rebuilder writes.
   */
  private async findPlannedRows(): Promise<boolean> {
    const running = this.scopeManifests
      .flatMap((m) => m.rebuilders)
      .filter((step) => this.stepRunsHere(step));
    const writers = writersOf(running);
    const byTable = new Map<string, [RebuildStep, PlannedRows][]>();
    for (const step of running) {
      for (const plan of step.plannedRows ?? []) {
        byTable.set(plan.table, [
          ...(byTable.get(plan.table) ?? []),
          [step, plan]
        ]);
      }
    }
    const readWhere = async (
      step: string,
      table: string,
      where: string
    ): Promise<Row[] | null> => {
      try {
        return await this.admin!.rowsWhere(MAIN_DB, table, where);
      } catch (error) {
        this.failures.push(
          `${step}'s planned rows of ${table} can't be read (where ${where}): ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
      }
    };
    for (const [table, plans] of Array.from(byTable)) {
      const found: FoundPlans = { keys: [], plans: [] };
      this.plannedRows.set(table, found);
      // A table the schema lacks has no seeded rows to plan.
      const rebuilt = this.rebuiltTables.includes(table);
      const primaryKey = rebuilt
        ? await this.admin!.primaryKey(MAIN_DB, table)
        : [];
      const keysOf = (rows: readonly Row[]) =>
        snapshotRows(table, rows, primaryKey, new Set(this.volatileOf(table)))
          .keys;
      for (const [step, plan] of plans) {
        if (!rebuilt) {
          this.notes.push(
            `Planned rows of ${table} by ${step.id}: its table isn't in this schema`
          );
        }
        const rows = rebuilt ? await readWhere(step.id, table, plan.where) : [];
        if (!rows) return false;
        for (const other of rebuilt ? (writers.get(table) ?? []) : []) {
          if (other.step === step.id || !other.partition) continue;
          const theirs = await this.admin!.rowsWhereInPartition(
            MAIN_DB,
            table,
            plan.where,
            other.partition.columns,
            other.partition.values
          );
          if (theirs) {
            this.failures.push(
              `${step.id}'s planned rows of ${table} include ${theirs} rows of ${other.step}'s partition; a plan covers only rows its rebuilder writes`
            );
            return false;
          }
        }
        const keys = keysOf(rows);
        found.plans.push({
          entry: plan,
          plan: {
            ...this.planOf(step.id, plan),
            seeded: rebuilt ? keys.length : null
          },
          keys,
          rows: plan.columns
            ? new Map(keys.map((key, i) => [key, rows[i]]))
            : null
        });
      }
      if (!rebuilt) continue;
      // A row is either missing or back with planned columns, not both.
      const overlap = rowAndColumnPlanOverlap(
        table,
        found.plans.map((p) => ({
          step: p.plan.step,
          columns: p.entry.columns,
          keys: p.keys
        }))
      );
      if (overlap) {
        this.failures.push(overlap);
        return false;
      }
      // Only plans of whole rows let rows be missing.
      const rowPlans = plans.filter(([, plan]) => !plan.columns);
      if (rowPlans.length === 1) {
        found.keys = found.plans.find((p) => !p.entry.columns)!.keys;
        continue;
      }
      if (!rowPlans.length) continue;
      // Every plan's rows at once, so a row two plans match counts once.
      const all = await readWhere(
        rowPlans.map(([step]) => step.id).join(', '),
        table,
        rowPlans.map(([, plan]) => `(${plan.where})`).join(' OR ')
      );
      if (!all) return false;
      found.keys = keysOf(all);
    }
    return true;
  }

  /**
   * Why a plan's columns can't be checked, or null: they must be in the
   * schema, and the table needs a primary key without a volatile column,
   * to find each matched row again after the rebuild.
   */
  /**
   * At the run's start, before the seeds: every column plan of a running
   * rebuilder names columns its table has, outside the primary key, on a
   * table whose primary key has no volatile column (see
   * columnPlanProblem).
   */
  private async plannedColumnsHold(): Promise<boolean> {
    const problems: string[] = [];
    const running = this.scopeManifests
      .flatMap((m) => m.rebuilders)
      .filter((step) => this.stepRunsHere(step));
    for (const step of running) {
      for (const plan of step.plannedRows ?? []) {
        if (!plan.columns || !this.baseTables.has(plan.table)) continue;
        const problem = columnPlanProblem({
          step: step.id,
          table: plan.table,
          columns: plan.columns,
          names: await this.admin!.columnNames(MAIN_DB, plan.table),
          primaryKey: await this.admin!.primaryKey(MAIN_DB, plan.table),
          volatile: new Set(this.volatileOf(plan.table))
        });
        if (problem) problems.push(problem);
      }
    }
    this.failures.push(...problems);
    return problems.length === 0;
  }

  /**
   * The rows of a table that changed only in the columns of the column
   * plans that matched them, after the rebuild (see columnPlanDecision):
   * each plan's counts are set on it.
   */
  private async plannedColumnRows(
    table: string,
    before: TableSnapshot,
    after: TableSnapshot
  ): Promise<Set<string>> {
    const columnPlans = (this.plannedRows.get(table)?.plans ?? []).filter(
      (p) => p.rows
    );
    if (!columnPlans.length) return new Set();
    const changed = changedKeys(before, after).filter((key) =>
      columnPlans.some((p) => p.rows!.has(key))
    );
    let rebuilt = new Map<string, Row>();
    const volatile = new Set(this.volatileOf(table));
    if (changed.length) {
      const primaryKey = await this.admin!.primaryKey(MAIN_DB, table);
      const rows = await this.admin!.orderedRows(MAIN_DB, table, primaryKey);
      const { keys } = snapshotRows(table, rows, primaryKey, volatile);
      rebuilt = new Map(keys.map((key, i) => [key, rows[i]]));
    }
    const { excused, counts } = columnPlanDecision({
      plans: columnPlans.map((p) => ({
        columns: p.entry.columns!,
        rows: p.rows!
      })),
      changed,
      rebuilt,
      volatile
    });
    columnPlans.forEach(({ plan }, i) => {
      plan.differing = counts[i].differing;
      plan.excused = counts[i].excused;
      plan.differingByColumn = counts[i].byColumn;
    });
    return excused;
  }

  /**
   * Tables kept through the drop: ephemeral, provider and exempt; unless
   * final, also INDEX tables no rebuilder (or only a skipped planned one)
   * writes.
   */
  private keptTables(): string[] {
    const base = new Set(
      this.live.filter((t) => t.type === 'BASE TABLE').map((t) => t.name)
    );
    const pending = new Set(this.registry!.pending.map((p) => p.table));
    const kept: string[] = [];
    this.entries().forEach(({ entry }, table) => {
      const waiting = pending.has(table) || this.plannedWrites.has(table);
      const keep = KEPT_CLASSES.has(entry.class) || (!this.o.final && waiting);
      if (keep && base.has(table)) kept.push(table);
    });
    return kept.sort((a, b) => a.localeCompare(b));
  }

  private async drop(kept: readonly string[]): Promise<boolean> {
    const admin = this.admin!;
    // In an area run, a table this area shares with another area's writer
    // loses only this area's partition; the other's rows stay as seeded.
    const ownPartitions = new Map<string, Partitions>();
    if (this.o.area) {
      const all = this.partitionedTables(
        this.o.manifests.flatMap((m) => m.rebuilders)
      );
      this.partitionedTables(
        this.scopeManifests.flatMap((m) => m.rebuilders)
      ).forEach((own, table) => {
        if (all.get(table)!.values.length > own.values.length) {
          ownPartitions.set(table, own);
        }
      });
    }
    const ownedOnly = this.ownedOnlyTables();
    await this.planOwnedColumns();
    if (this.o.area) {
      this.o.log(
        `truncating ${this.rebuiltTables.length} tables of ${this.o.area}`
      );
      await admin.truncate(
        MAIN_DB,
        this.rebuiltTables.filter(
          (t) => !ownPartitions.has(t) && !ownedOnly.has(t)
        )
      );
      for (const [table, { columns, values }] of Array.from(ownPartitions)) {
        await admin.deletePartition(MAIN_DB, table, columns, values);
      }
      // Kept rows go back to their state before the first probe pass.
      await admin.truncate(MAIN_DB, kept);
      for (const table of kept) await admin.copyRows(KEPT_DB, MAIN_DB, table);
    } else {
      this.o.log('dropping the database');
      await admin.recreateDatabase(MAIN_DB);
      if (!(await this.buildSchema('schema-after-drop'))) return false;
      this.o.log(`restoring ${kept.length} kept tables`);
      // Rows the schema build wrote into a kept table give way to the
      // copy, as in an area run.
      await admin.truncate(MAIN_DB, kept);
      for (const table of kept) await admin.copyRows(KEPT_DB, MAIN_DB, table);
    }
    // A table kept because a skipped rebuilder writes part of it keeps
    // only the parts no rebuilder running here writes: the copy put every
    // row back, so the running writers' partitions are emptied for them to
    // rebuild.
    const running = this.runningPartitionsOf(kept);
    for (const [table, { columns, values }] of Array.from(running)) {
      await admin.deletePartition(MAIN_DB, table, columns, values);
    }
    // A table no running row writer rewrites (its rows kept, or left as
    // seeded) is ready for its owners now, after the kept copy and the
    // partition deletes; the others once their row writers are done.
    for (const [table, plan] of Array.from(this.ownedAfterRows)) {
      if (!plan.waiting.size) await this.afterRowWriters(table);
    }
    const keptSet = new Set(kept);
    const entries = this.entries();
    const mustBeEmpty = this.o.area
      ? this.rebuiltTables.filter((table) => !ownedOnly.has(table))
      : [
          ...this.live
            .filter(
              (t) =>
                t.type === 'BASE TABLE' &&
                !keptSet.has(t.name) &&
                entries.get(t.name)?.entry.class === 'INDEX'
            )
            .map((t) => t.name),
          ...Array.from(running.keys())
        ];
    for (const table of mustBeEmpty) {
      const own = running.get(table) ?? ownPartitions.get(table);
      const rows = own
        ? await admin.partitionRowCount(
            MAIN_DB,
            table,
            own.columns,
            own.values,
            true
          )
        : await admin.rowCount(MAIN_DB, table);
      if (rows > 0) this.notEmptyAfterDrop.push(table);
    }
    if (this.notEmptyAfterDrop.length) {
      this.failures.push(
        `Not empty after the drop: ${this.notEmptyAfterDrop.join(', ')}`
      );
    }
    return true;
  }

  private async setUp(): Promise<boolean> {
    for (const problem of preflightProblems(this.o.repoRoot, process.env)) {
      this.failures.push(problem);
    }
    if (this.o.area && !this.o.manifests.some((m) => m.area === this.o.area)) {
      this.failures.push(`No manifest for area ${this.o.area}`);
    }
    const codeTables: CodeTables = discoverCodeTables();
    if (this.o.today !== undefined && !validUntil(this.o.today)) {
      this.failures.push(
        `The run's day ${this.o.today} is not a day written YYYY-MM-DD`
      );
    }
    this.registry = checkRegistry({
      manifests: this.o.manifests,
      codeTables,
      stepCodeHere: this.stepCodeHere
    });
    if (this.failures.length || this.registry.problems.length) return false;
    fs.mkdirSync(path.join(this.runDir, 'logs'), { recursive: true });
    this.releaseLock = acquireHomeLock(path.resolve(this.o.home));
    this.apiPort = this.o.apiPort || (await freePort());
    this.running = await startSources(this.o.sources, this.runDir);
    for (const source of this.running) {
      this.o.log(`${source.name}: ${source.info.mode} at ${source.url}`);
    }
    this.server = await startLocalMysqld({
      home: this.o.home,
      port: this.o.mysqlPort,
      mysqldPath: this.o.mysqldPath,
      log: this.o.log
    });
    this.admin = await MysqlAdmin.connect(this.server.target);
    const [version] = await this.admin.query<{ v: string }>(
      'SELECT VERSION() AS v'
    );
    this.mysqlVersion = version.v;
    await this.admin.recreateDatabase(MAIN_DB);
    await this.admin.recreateDatabase(KEPT_DB);
    await this.admin.createAppUser(APP_USER, this.appPassword, MAIN_DB);
    if (!(await this.buildSchema('schema'))) return false;
    this.live = await liveSchemaTables(
      (sql, params) => this.admin!.query(sql, params),
      MAIN_DB
    );
    this.registry = checkRegistry({
      manifests: this.o.manifests,
      codeTables,
      liveTables: this.live,
      stepCodeHere: this.stepCodeHere
    });
    return this.registry.problems.length === 0;
  }

  private async check(): Promise<void> {
    if (!(await this.setUp())) return;
    const flags = this.allFlags();
    const base = new Set(
      this.live.filter((t) => t.type === 'BASE TABLE').map((t) => t.name)
    );
    this.baseTables = base;
    this.staleNeeds = this.findStaleNeeds(base);
    if (!(await this.checkpointColumnsHold())) return;
    if (!(await this.partitionsDisjointInMysql())) return;
    if (!(await this.ownedColumnsExist())) return;
    if (!(await this.plannedColumnsHold())) return;
    const all = expandAll(this.o.manifests);
    const waits = (call: ProbeCall) =>
      call.probe.origin === 'planned' &&
      (call.probe.needs ?? []).some((table) => !base.has(table));
    this.calls = all.filter((call) => !waits(call));
    this.heldProbes = all.filter(waits).map((call) => call.id);
    const rebuilders = this.scopeManifests.flatMap((m) => m.rebuilders);
    this.rebuiltTables = Array.from(
      new Set(
        rebuilders.filter((s) => this.stepRunsHere(s)).flatMap(writtenTables)
      )
    )
      .filter((t) => base.has(t))
      .sort((a, b) => a.localeCompare(b));
    this.plannedWrites = new Set(
      rebuilders.filter((s) => !this.stepRunsHere(s)).flatMap(rowWrittenTables)
    );
    // Owned columns whose owner doesn't run here: another area's, or
    // skipped. The row comparison leaves them out, and a final run fails.
    const steps = new Map(
      this.o.manifests.flatMap((m) => m.rebuilders).map((s) => [s.id, s])
    );
    const inScope = new Set(rebuilders.map((s) => s.id));
    const whyNot = (id: string): string | null => {
      const step = steps.get(id)!;
      if (!inScope.has(id)) return "another area's";
      if (!this.stepCodeHere(step))
        return 'planned, its code is not in this tree';
      const missing = this.missingNeeds(step);
      return missing.length
        ? `waits for ${missing.map((need) => need.table).join(', ')}`
        : null;
    };
    this.unrunOwnedColumns = Array.from(this.columnOwners()).flatMap(
      ([table, owners]) =>
        this.rebuiltTables.includes(table)
          ? owners.flatMap((owner) => {
              const why = whyNot(owner.step);
              return why === null
                ? []
                : owner.columns.map((column) => ({
                    table,
                    column,
                    owner: owner.step,
                    why
                  }));
            })
          : []
    );
    if (!(await this.runSteps('seed', this.o.manifests))) return;
    this.seededRows = await this.countIndexRows(base);
    this.unownedRows = await this.findUnownedRows(base);
    const kept = this.keptTables();
    this.o.log(`copying ${kept.length} kept tables aside`);
    await this.admin!.copyTables(MAIN_DB, KEPT_DB, kept);
    const before = await this.probePass(
      'a',
      this.o.mark === 'switch' ? {} : flags
    );
    if (!before) return;
    await this.findUnreadTables();
    const snapshotsBefore = await this.snapshots(this.rebuiltTables);
    if (!(await this.findPlannedRows())) return;
    if (!(await this.drop(kept))) return;
    if (!(await this.runSteps('rebuilder', this.scopeManifests))) return;
    const after = await this.probePass('b', flags);
    if (!after) return;
    const outcomes = diffAnswers(this.calls, before, after);
    this.differences = outcomes.filter((d) => d.kind === 'failure');
    this.unproven = outcomes.filter((d) => d.kind === 'unproven');
    this.compared = true;
    const snapshotsAfter = await this.snapshots(this.rebuiltTables);
    const diffs: TableDiff[] = [];
    for (const t of this.rebuiltTables) {
      const before = snapshotsBefore.get(t)!;
      const after = snapshotsAfter.get(t)!;
      diffs.push(
        diffSnapshots(
          before,
          after,
          20,
          this.plannedRows.get(t)?.keys,
          await this.plannedColumnRows(t, before, after)
        )
      );
    }
    this.tableDiffs = diffs;
    this.plannedRows.forEach((found, table) => {
      const before = snapshotsBefore.get(table);
      const after = snapshotsAfter.get(table);
      if (!before || !after) return;
      for (const { plan, keys } of found.plans) {
        plan.missing = goneRows(before, after, keys);
      }
    });
  }

  /** What stopped the run before pass B compared, or null when it did. */
  private stoppedBefore(): string | null {
    if (this.compared) return null;
    const step = this.steps.find((s) => s.exitCode !== 0 || s.timedOut);
    if (step) return `step ${step.kind} ${step.id}`;
    if (this.registry?.problems.length) return 'the registry check';
    const first = this.failures[0]?.split('\n')[0];
    if (!first) return 'an early stop';
    return first.length > 120 ? `${first.slice(0, 117)}...` : first;
  }

  private verdict(violations: SourceViolation[]): void {
    const stepViolations = violations.filter(
      (v) => this.stepPids.get(v.pid) !== 'api'
    ).length;
    const verdict = judge({
      final: this.o.final,
      stepViolations,
      apiViolations: violations.length - stepViolations,
      unguardedSteps: this.steps.filter((s) => !s.guarded).map((s) => s.id),
      differences: this.differences.length,
      unproven: this.unproven.length,
      pending: (this.registry?.pending ?? []).length,
      unreadTables: this.unreadTables,
      differingTables: this.tableDiffs.filter((d) => !d.same).length,
      unseededTables: this.unseededTables(),
      exemptTables: this.registry?.classes.EXEMPT ?? 0,
      exemptUntil: this.exemptTablesUntil,
      sourceProblems: this.running.flatMap((source) => source.problems()),
      provisionalSources: this.running
        .filter((source) => source.info.provisional)
        .map((source) => source.name),
      plannedTables: (this.registry?.plannedAbsent ?? []).length,
      plannedSteps: this.plannedSteps,
      plannedStepsHere: this.plannedStepsHere(),
      unresolvedEdges: this.unresolvedEdges(),
      orderLeftOut: (this.registry?.orderLeftOut ?? []).map(
        (entry) => `${entry.step} (${entry.tables.join(', ')})`
      ),
      waitingSteps: this.waitingSteps,
      staleNeeds: this.staleNeeds,
      unownedRows: this.unownedRows,
      plannedRows: this.plannedRowsFound().flatMap((p) =>
        p.plans.map((plan) => ({ ...plan, table: p.table }))
      ),
      unrunOwnedColumns: this.unrunOwnedColumns.map(
        (owned) =>
          `${owned.table}.${owned.column} (${owned.owner}, ${owned.why})`
      ),
      heldProbes: this.heldProbes,
      notInSchema: this.notInSchema().map((a) => a.table),
      openRoutes: this.routes().open.length
    });
    this.failures.push(...verdict.failures);
    this.notes.push(...verdict.notes);
  }

  private routesCache: ReturnType<typeof routeCoverage> | null = null;

  private routes(): ReturnType<typeof routeCoverage> {
    if (!this.routesCache) {
      const waivers = this.o.manifests.flatMap((m) =>
        (m.waivers?.routes ?? []).map((w) => w.target)
      );
      this.routesCache = routeCoverage(
        readDocumentedRoutes(this.o.repoRoot),
        this.calls,
        waivers
      );
    }
    return this.routesCache;
  }

  private areaSummaries(): AreaSummary[] {
    const pending = this.registry?.pending ?? [];
    return this.o.manifests.map((manifest) => {
      const entries = Object.values(manifest.tables);
      const tables = Object.keys(manifest.tables);
      return {
        area: manifest.area,
        tables: tables.length,
        index: entries.filter((e) => e.class === 'INDEX').length,
        kept: entries.filter((e) => KEPT_CLASSES.has(e.class)).length,
        rebuilt: this.rebuiltTables.filter((t) => t in manifest.tables).length,
        pending: pending.filter((p) => p.area === manifest.area).length,
        probes: this.calls.filter((c) => c.area === manifest.area).length,
        differences: this.differences.filter((d) => d.area === manifest.area)
          .length,
        unproven: this.unproven.filter((d) => d.area === manifest.area).length,
        seeded: Object.keys(manifest.tables).filter(
          (t) => (this.seededRows[t] ?? 0) > 0
        ).length,
        failedSteps: this.steps.filter(
          (s) => s.area === manifest.area && s.exitCode !== 0
        ).length
      };
    });
  }

  /**
   * Tables a manifest keeps or rebuilds that the schema build doesn't make
   * (entity sync and the migrations loop's schema steps; the old db-migrate
   * scripts don't run). Left out: planned tables whose code isn't here,
   * tables made at runtime by design, and SCHEMA tables.
   */
  private notInSchema(): { area: string; table: string }[] {
    if (!this.live.length) return [];
    const live = new Set(this.live.map((t) => t.name));
    const planned = new Set(
      (this.registry?.plannedAbsent ?? []).map((p) => p.table)
    );
    return this.o.manifests.flatMap((manifest) =>
      Object.entries(manifest.tables)
        .filter(
          ([table, entry]) =>
            entry.class !== 'RETIRED' &&
            entry.class !== 'VIEW' &&
            entry.class !== 'SCHEMA' &&
            entry.origin !== 'runtime' &&
            !live.has(table) &&
            !planned.has(table)
        )
        .map(([table]) => ({ area: manifest.area, table }))
    );
  }

  /** Rows in each INDEX table the schema has, so a probe's data has a source. */
  private async countIndexRows(
    base: ReadonlySet<string>
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const tables = this.o.manifests
      .flatMap((m) =>
        Object.entries(m.tables)
          .filter(
            ([table, entry]) => entry.class === 'INDEX' && base.has(table)
          )
          .map(([table]) => table)
      )
      .sort((a, b) => a.localeCompare(b));
    for (const table of tables) {
      counts[table] = await this.admin!.rowCount(MAIN_DB, table);
    }
    return counts;
  }

  /** Rebuilt tables with no rows after the seeds and no waiver. */
  private unseededTables(): string[] {
    const waived = new Set(
      this.o.manifests.flatMap((m) =>
        (m.waivers?.unseededTables ?? []).map((w) => w.target)
      )
    );
    return this.rebuiltTables.filter(
      (t) => !waived.has(t) && (this.seededRows[t] ?? 0) === 0
    );
  }

  /**
   * What the row comparison leaves out of the rebuilt tables: volatile
   * columns, and a checkpoint table's rows before its newest.
   */
  private volatileColumns(): RunReport['tables']['volatileColumns'] {
    const entries = this.entries();
    return this.rebuiltTables.flatMap((table) => {
      const entry = entries.get(table)?.entry;
      return [
        ...(entry?.volatileColumns ?? []).map((v) => ({
          table,
          column: v.column,
          reason: v.reason
        })),
        ...(entry?.checkpoint
          ? [
              {
                table,
                column: `rows before the newest by ${entry.checkpoint.column}`,
                reason: entry.checkpoint.reason
              }
            ]
          : []),
        ...(entry?.exemptColumns ?? []).map((e) => ({
          table,
          column: e.column,
          reason: `exempt: ${e.reason}`
        }))
      ];
    });
  }

  /** A plan as the report shows it before its rows are read. */
  private planOf(step: string, plan: PlannedRows): PlannedRowsPlan {
    return {
      step,
      where: plan.where,
      reason: plan.reason,
      until: plan.until,
      change: plan.change,
      seeded: null,
      missing: null,
      overdue: this.day > plan.until,
      ...(plan.columns
        ? { columns: [...plan.columns], differing: null, excused: null }
        : {})
    };
  }

  /**
   * Every plan of the run's rebuilders, from the manifests, by table: with
   * the seeded rows it matched and the planned rows missing from the
   * rebuild once the run has read them, and marked overdue from its day
   * either way.
   */
  private plannedRowsFound(): RunReport['tables']['plannedRows'] {
    const byTable = new Map<string, PlannedRowsPlan[]>();
    for (const step of this.scopeManifests.flatMap((m) => m.rebuilders)) {
      for (const entry of step.plannedRows ?? []) {
        const found = this.plannedRows
          .get(entry.table)
          ?.plans.find((p) => p.entry === entry)?.plan;
        byTable.set(entry.table, [
          ...(byTable.get(entry.table) ?? []),
          found ?? this.planOf(step.id, entry)
        ]);
      }
    }
    return Array.from(byTable)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([table, plans]) => {
        const diff = this.tableDiffs.find((d) => d.table === table);
        return {
          table,
          rows: diff?.plannedRows ?? 0,
          keys: diff?.planned ?? [],
          columnRows: diff?.plannedColumnRows ?? 0,
          columnKeys: diff?.plannedColumns ?? [],
          plans
        };
      });
  }

  /** Unresolved cross-area order edges, as the verdict and report list them. */
  private unresolvedEdges(): string[] {
    return (this.registry?.crossAreaEdges ?? []).map(
      (edge) =>
        `${edge.step} ${edge.field} ${edge.id}${edge.nearest ? ` (did you mean ${edge.nearest}?)` : ''}`
    );
  }

  /** Steps of this run marked planned whose code is in this tree. */
  private plannedStepsHere(): string[] {
    return this.scopeManifests
      .flatMap((m) => [...m.seeds, ...m.rebuilders])
      .filter((step) => step.origin === 'planned' && this.stepCodeHere(step))
      .map((step) => step.id);
  }

  /** Rebuilders that declare reads of kept tables. */
  private keptReads(): KeptRead[] {
    const entries = this.entries();
    return this.o.manifests.flatMap((manifest) =>
      manifest.rebuilders.flatMap((step) =>
        (step.reads ?? [])
          .map((table) => ({ table, entry: entries.get(table)?.entry }))
          .filter(({ entry }) => entry && KEPT_CLASSES.has(entry.class))
          .map(({ table, entry }) => ({
            step: step.id,
            area: manifest.area,
            table,
            class: entry!.class
          }))
      )
    );
  }

  async run(): Promise<{ report: RunReport; runDir: string }> {
    try {
      await this.check();
    } catch (error) {
      this.failures.push(
        `The run stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
      );
    } finally {
      this.admin?.destroy();
      await this.server
        ?.stop()
        .catch((error) =>
          this.failures.push(`mysqld did not stop cleanly: ${String(error)}`)
        );
      await stopSources(this.running);
      this.releaseLock?.();
    }
    const violations = readViolations(this.violationsFile);
    this.verdict(violations);
    const registry = this.registry;
    const report: RunReport = {
      verdict:
        this.failures.length || registry?.problems.length ? 'FAIL' : 'PASS',
      scope: this.scope,
      mark: this.o.mark,
      final: this.o.final,
      startedAt: this.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      backendHead: gitHead(this.o.repoRoot),
      mysql: { version: this.mysqlVersion, port: this.o.mysqlPort },
      sources: this.sourceInfo(),
      classes: registry?.classes ?? {
        INDEX: 0,
        EPHEMERAL: 0,
        PROVIDER: 0,
        SCHEMA: 0,
        VIEW: 0,
        RETIRED: 0,
        EXEMPT: 0
      },
      areas: this.areaSummaries(),
      registryProblems: registry?.problems ?? [],
      pending: registry?.pending ?? [],
      planned: registry?.plannedAbsent ?? [],
      notInSchema: this.notInSchema(),
      keptReads: this.keptReads(),
      steps: this.steps,
      violations,
      probes: {
        calls: this.calls.length,
        differences: this.differences,
        unproven: this.unproven,
        unreadTables: this.unreadTables,
        stoppedBefore: this.stoppedBefore()
      },
      routes: {
        documented:
          this.routes().probed.length +
          this.routes().waived.length +
          this.routes().open.length,
        probed: this.routes().probed.length,
        waived: this.routes().waived.length,
        open: this.routes().open
      },
      tables: {
        rebuilt: this.rebuiltTables,
        diffs: this.tableDiffs,
        notEmptyAfterDrop: this.notEmptyAfterDrop,
        seededRows: this.seededRows,
        volatileColumns: this.volatileColumns(),
        ownedColumnsLeftOut: this.unrunOwnedColumns,
        day: this.day,
        exemptUntil: this.exemptTablesUntil,
        plannedRows: this.plannedRowsFound()
      },
      unresolvedEdges: this.unresolvedEdges(),
      failures: this.failures,
      notes: this.notes
    };
    writeReport(this.runDir, this.statusFile, report);
    return { report, runDir: this.runDir };
  }
}

/**
 * Seeds the stack, probes the API, drops every table that is not kept, runs
 * the rebuilders, probes again and compares. See docs/rebuild-check.md.
 */
export function runRebuildCheck(
  options: RunOptions
): Promise<{ report: RunReport; runDir: string }> {
  return new RebuildRun(options).run();
}
