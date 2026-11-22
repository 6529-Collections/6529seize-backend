import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import {
  AreaManifest,
  RebuildContext,
  RebuildSource,
  RebuildStep,
  TableClass,
  TableEntry
} from '@/rebuild/manifest.types';
import { checkRegistry, RegistryResult } from '@/rebuild/registry-check';
import { orderSteps } from '@/rebuild/step-order';
import {
  CodeTables,
  discoverCodeTables,
  LiveTable,
  liveSchemaTables
} from '@/rebuild/table-discovery';
import {
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
import { MysqlAdmin } from '@/rebuild/stack/mysql-admin';
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
  diffSnapshots,
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
import { judge } from '@/rebuild/run/verdict';
import { waitForApi } from '@/rebuild/stack/api-ready';

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
  /** Planned probes held because a table they need isn't in the schema. */
  private heldProbes: string[] = [];
  /** Tables only a skipped planned rebuilder writes: kept like pending ones. */
  private plannedWrites = new Set<string>();
  /** Rows in each INDEX table of the schema after the seeds ran. */
  private seededRows: Record<string, number> = {};
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
          writes: step.writes.filter((t) => baseNames.has(t)),
          reads: (step.reads ?? []).filter((t) => liveNames.has(t))
        })
      );
      account = { ...account, user, password };
    }
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
    const rowsWritten: Record<string, number> = {};
    for (const table of step.writes.filter((t) => baseNames.has(t))) {
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
    for (const step of orderSteps(all).order) {
      if (!this.stepCodeHere(step)) {
        this.o.log(`${kind} ${step.id}: planned, its module is not here`);
        this.plannedSteps.push(step.id);
        continue;
      }
      this.o.log(`${kind} ${step.id}`);
      if (!(await this.runStep(kind, areaOf.get(step.id)!, step))) return false;
    }
    return true;
  }

  /** False for a planned module step whose module isn't in this tree. */
  private stepCodeHere(step: RebuildStep): boolean {
    if (step.origin !== 'planned' || !('module' in step.run)) return true;
    const base = path.join(this.o.repoRoot, step.run.module);
    return ['.ts', '.js'].some((ext) => fs.existsSync(`${base}${ext}`));
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

  private async snapshots(
    tables: readonly string[]
  ): Promise<Map<string, TableSnapshot>> {
    const entries = this.entries();
    const result = new Map<string, TableSnapshot>();
    for (const table of tables) {
      const volatile = (entries.get(table)?.entry.volatileColumns ?? []).map(
        (c) => c.column
      );
      result.set(
        table,
        await snapshotTable(this.admin!, MAIN_DB, table, volatile)
      );
    }
    return result;
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
    if (this.o.area) {
      this.o.log(
        `truncating ${this.rebuiltTables.length} tables of ${this.o.area}`
      );
      await admin.truncate(MAIN_DB, this.rebuiltTables);
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
    const keptSet = new Set(kept);
    const entries = this.entries();
    const mustBeEmpty = this.o.area
      ? this.rebuiltTables
      : this.live
          .filter(
            (t) =>
              t.type === 'BASE TABLE' &&
              !keptSet.has(t.name) &&
              entries.get(t.name)?.entry.class === 'INDEX'
          )
          .map((t) => t.name);
    for (const table of mustBeEmpty) {
      if ((await admin.rowCount(MAIN_DB, table)) > 0)
        this.notEmptyAfterDrop.push(table);
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
    this.registry = checkRegistry({ manifests: this.o.manifests, codeTables });
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
      liveTables: this.live
    });
    return this.registry.problems.length === 0;
  }

  private async check(): Promise<void> {
    if (!(await this.setUp())) return;
    const flags = this.allFlags();
    const base = new Set(
      this.live.filter((t) => t.type === 'BASE TABLE').map((t) => t.name)
    );
    const all = expandAll(this.o.manifests);
    const waits = (call: ProbeCall) =>
      call.probe.origin === 'planned' &&
      (call.probe.needs ?? []).some((table) => !base.has(table));
    this.calls = all.filter((call) => !waits(call));
    this.heldProbes = all.filter(waits).map((call) => call.id);
    const rebuilders = this.scopeManifests.flatMap((m) => m.rebuilders);
    this.rebuiltTables = Array.from(
      new Set(
        rebuilders.filter((s) => this.stepCodeHere(s)).flatMap((s) => s.writes)
      )
    )
      .filter((t) => base.has(t))
      .sort((a, b) => a.localeCompare(b));
    this.plannedWrites = new Set(
      rebuilders.filter((s) => !this.stepCodeHere(s)).flatMap((s) => s.writes)
    );
    if (!(await this.runSteps('seed', this.o.manifests))) return;
    this.seededRows = await this.countIndexRows(base);
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
    if (!(await this.drop(kept))) return;
    if (!(await this.runSteps('rebuilder', this.scopeManifests))) return;
    const after = await this.probePass('b', flags);
    if (!after) return;
    const outcomes = diffAnswers(this.calls, before, after);
    this.differences = outcomes.filter((d) => d.kind === 'failure');
    this.unproven = outcomes.filter((d) => d.kind === 'unproven');
    this.compared = true;
    const snapshotsAfter = await this.snapshots(this.rebuiltTables);
    this.tableDiffs = this.rebuiltTables.map((t) =>
      diffSnapshots(snapshotsBefore.get(t)!, snapshotsAfter.get(t)!)
    );
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
      sourceProblems: this.running.flatMap((source) => source.problems()),
      provisionalSources: this.running
        .filter((source) => source.info.provisional)
        .map((source) => source.name),
      plannedTables: (this.registry?.plannedAbsent ?? []).length,
      plannedSteps: this.plannedSteps,
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

  /** The rebuilt tables' columns the row comparison leaves out. */
  private volatileColumns(): RunReport['tables']['volatileColumns'] {
    const entries = this.entries();
    return this.rebuiltTables.flatMap((table) =>
      (entries.get(table)?.entry.volatileColumns ?? []).map((v) => ({
        table,
        column: v.column,
        reason: v.reason
      }))
    );
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
        volatileColumns: this.volatileColumns()
      },
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
