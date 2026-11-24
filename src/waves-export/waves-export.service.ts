import { compactDrop } from './waves-export.compact';
import {
  WavesExportStoppedError,
  WavesExportUsageError
} from './waves-export.errors';
import { groupCriteriaReasons, groupRaterKeys } from './waves-export.groups';
import { compareCodePoints } from './waves-export.json';
import type { ReplicaLagRecord } from './waves-export.replica-lag';
import {
  groupStays,
  STAY_REASONS,
  StayReason
} from '@/waves-scope/waves-scope';
import {
  ExportActiveEntry,
  ExportSignedDrop,
  ExportCuration,
  ExportWaveRow,
  Json,
  WavesExportSource
} from './waves-export.types';
import { RawDirectory } from './waves-export.writer';

export const WAVES_EXPORT_STAGES = [
  'waves',
  'decisions',
  'votes',
  'logs',
  'groups',
  'waverep',
  'polls',
  'drops'
] as const;

export type WavesExportStage = (typeof WAVES_EXPORT_STAGES)[number];

export const WAVES_EXPORT_FORMAT = '6529io-waves-export-raw-v1';

/**
 * Every run of the export into one OUT/raw, in order: what it ran and the
 * replica lag record it started on. A run adds its own before its first
 * stage reads, so a run that stops still leaves it, and none is dropped.
 */
export const EXPORT_RUNS_FILE = 'export_runs.json';

export interface WavesExportRun {
  readonly run_started_at: number;
  /** T_w in ms; null for a rehearsal. */
  readonly freeze_ms: number | null;
  readonly exporter_revision: string;
  /** The signed records wave this run kept on 6529.io; null for none. */
  readonly records_wave_id: string | null;
  readonly stages: readonly WavesExportStage[];
  /** The replica lag check this run started on (null when none was given). */
  readonly replica_lag: ReplicaLagRecord | null;
}

/**
 * The waves stage's staying waves (src/waves-scope): how many stay by each
 * reason, and which ones, direct messages but counted. Nothing else of a
 * staying wave is read.
 */
export const STAYING_WAVES_FILE = 'waves_staying.json';

/**
 * Groups a wave that moves names but the groups stage left out: hidden or
 * private, a direct message's, or made after the freeze. The rule keeps
 * such a group's waves on 6529.io, so there are none unless a group
 * changed since the waves stage.
 */
export const STAYING_GROUPS_FILE = 'groups_staying.json';

/**
 * The curations of the waves written, by wave: every wave of waves_v3.json
 * has an entry (an empty list for none), each curation with its id, wave
 * and group. The snapshot builder walks their groups (site_scope.py).
 */
export const CURATIONS_FILE = 'curations.json';

/** Why a group the export reads is left out. */
export type GroupStayReason =
  | StayReason.HIDDEN_OR_PRIVATE_GROUP
  | StayReason.DIRECT_MESSAGE
  | StayReason.GROUP_CREATED_AFTER_FREEZE;

const GROUP_STAY_REASONS: readonly GroupStayReason[] = [
  StayReason.DIRECT_MESSAGE,
  StayReason.HIDDEN_OR_PRIVATE_GROUP,
  StayReason.GROUP_CREATED_AFTER_FREEZE
];

interface StayingWaves {
  readonly total: number;
  readonly by_reason: Record<StayReason, number>;
  /** Each staying wave but direct messages, with its reasons. */
  readonly waves: Record<string, readonly StayReason[]>;
}

/** Drops a batch read of signed events takes (the public batch's size). */
const SIGNED_BATCH = 50;

/** Tries of one read (a wave, a decision, a wave's drops) before giving up. */
const ATTEMPTS = 3;

export interface WavesExportOptions {
  /** OUT/raw. */
  readonly raw: RawDirectory;
  readonly stages: readonly WavesExportStage[];
  /** T_w in ms: polls are read open or closed as at this time. */
  readonly freezeMs: number | null;
  readonly exporterRevision: string;
  /** Only these waves (a rehearsal); null for every wave. */
  readonly waveIds: readonly string[] | null;
  readonly dropPageSize: number;
  readonly concurrency: number;
  /** TDH plus xTDH as a clause metric (the snapshot tooling's --both-metric). */
  readonly bothMetric: boolean;
  /**
   * The signed records wave's id (SIGNED_RECORDS_WAVE_ID, or the export's own
   * setting): it stays on 6529.io, matched by id only. Null when the setting
   * says there is none.
   */
  readonly recordsWaveId: string | null;
  /** Keep a wave's drops already written by an earlier run of this export. */
  readonly resumeDrops?: boolean;
  /**
   * Asked before each wave's drops are read: true leaves that wave, and
   * every wave not started yet, for a later run with resumeDrops. The waves
   * already being read finish first; then the stage throws
   * WavesExportStoppedError. For a job with a time limit; the CLI never
   * stops.
   */
  readonly stopBeforeWave?: () => boolean;
  /** Wait before trying a failed read again (tests pass 0). */
  readonly retryDelayMs?: number;
  /**
   * The replica lag check this run started on (a rehearsal's only reports
   * it), kept in EXPORT_RUNS_FILE with every earlier run's.
   */
  readonly replicaLag?: ReplicaLagRecord | null;
  readonly now?: () => number;
  readonly log: (message: string) => void;
}

export interface WavesExportSummary {
  readonly format: string;
  readonly freeze_ms: number | null;
  readonly exporter_revision: string;
  readonly stages: readonly WavesExportStage[];
  readonly both_metric: boolean;
  readonly counts: Record<string, number>;
  /** Waves the backend could not read: left out of the export. */
  readonly failed_waves: { readonly id: string; readonly error: string }[];
}

type WaveV3 = { id: string; configuration?: Json; _error?: string };

function asObject(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function idOf(value: unknown): string | null {
  const id = asObject(value).id;
  return typeof id === 'string' && id ? id : null;
}

function sortedKeys<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort(compareCodePoints)) {
    out[key] = record[key];
  }
  return out;
}

/** Runs `work` over `items`, at most `limit` at a time, in order of start. */
export async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const item = items[next++];
        await work(item);
      }
    }
  );
  await Promise.all(workers);
}

/**
 * Why a group, as the API shows it, stays on 6529.io (the shared rule's
 * groupStays, with the waves freeze in ms; null in a rehearsal), or null
 * when it moves. A group made after the freeze says so first, as the rule
 * names it for a wave that uses it.
 */
export function groupStayReason(
  group: Json,
  freezeMs: number | null
): GroupStayReason | null {
  const fields = {
    visible: group.visible === true,
    is_private: group.is_private === true,
    is_direct_message: group.is_direct_message === true,
    created_at: typeof group.created_at === 'number' ? group.created_at : null
  };
  if (!groupStays(fields, freezeMs)) return null;
  if (
    groupStays(
      { ...fields, visible: true, is_private: false, is_direct_message: false },
      freezeMs
    )
  ) {
    return StayReason.GROUP_CREATED_AFTER_FREEZE;
  }
  return fields.is_direct_message
    ? StayReason.DIRECT_MESSAGE
    : StayReason.HIDDEN_OR_PRIVATE_GROUP;
}

/**
 * The groups a wave's configuration shows, for its `/v3` read: every group
 * the wave names and its parent's read group, so private ones show their id.
 */
export function eligibleGroupsForWave(
  wave: ExportWaveRow,
  byId: ReadonlyMap<string, ExportWaveRow>
): string[] {
  const parent = wave.parent_wave_id ? byId.get(wave.parent_wave_id) : null;
  const ids = [
    wave.visibility_group_id,
    wave.admin_group_id,
    wave.chat_group_id,
    wave.participation_group_id,
    wave.voting_group_id,
    parent?.visibility_group_id ?? null
  ].filter((id): id is string => !!id);
  return Array.from(new Set(ids)).sort(compareCodePoints);
}

/**
 * The groups the import carries and their roles, from the waves' and
 * decisions' configurations (snapshot tooling, waves_fetch.py named_groups).
 */
export function namedGroups(
  waves: Record<string, WaveV3>,
  competitions: Record<string, Json>
): Map<string, Set<string>> {
  const uses = new Map<string, Set<string>>();
  const add = (id: string | null, role: string) => {
    if (!id) return;
    const roles = uses.get(id) ?? new Set<string>();
    roles.add(role);
    uses.set(id, roles);
  };
  for (const wave of Object.values(waves)) {
    const c = wave.configuration;
    if (!c) continue;
    add(idOf(asObject(asObject(c.visibility).scope).group), 'read');
    add(idOf(asObject(asObject(c.chat).scope).group), 'post');
    add(idOf(asObject(asObject(c.wave).admin_group).group), 'admin');
  }
  for (const competition of Object.values(competitions)) {
    const submit = asObject(competition.participation).group_id;
    const vote = asObject(competition.voting).group_id;
    add(typeof submit === 'string' ? submit : null, 'submit');
    add(typeof vote === 'string' ? vote : null, 'vote');
  }
  return uses;
}

/**
 * Every group the export writes to groups.json, with its roles: the fetch
 * stage's (namedGroups), a wave's own submit and vote groups as its
 * configuration shows them, and every curation's group. The snapshot
 * builder walks them all to check that every wave moves.
 */
export function exportedGroups(
  waves: Record<string, WaveV3>,
  competitions: Record<string, Json>,
  curations: Record<string, readonly ExportCuration[]>
): Map<string, Set<string>> {
  const uses = namedGroups(waves, competitions);
  const add = (id: string | null, role: string) => {
    if (!id) return;
    const roles = uses.get(id) ?? new Set<string>();
    roles.add(role);
    uses.set(id, roles);
  };
  for (const wave of Object.values(waves)) {
    const c = wave.configuration;
    if (!c) continue;
    add(idOf(asObject(asObject(c.participation).scope).group), 'submit');
    add(idOf(asObject(asObject(c.voting).scope).group), 'vote');
  }
  for (const waveCurations of Object.values(curations)) {
    for (const curation of waveCurations) {
      add(curation.group_id || null, 'curation');
    }
  }
  return uses;
}

/** ACTIVE entries of PUBLISHED decisions, in decision then entry order. */
export function activeEntries(
  competitions: Record<string, Json>,
  details: Record<string, { entries: Json[] }>
): ExportActiveEntry[] {
  const out: ExportActiveEntry[] = [];
  for (const id of Object.keys(details).sort(compareCodePoints)) {
    const competition = competitions[id];
    if (!competition || competition.lifecycle !== 'PUBLISHED') continue;
    for (const entry of details[id].entries) {
      if (entry.status !== 'ACTIVE') continue;
      out.push({
        competition_id: id,
        wave_id: String(competition.wave_id),
        entry_id: String(entry.id),
        drop_id: String(entry.drop_id)
      });
    }
  }
  return out;
}

export class WavesExport {
  private readonly counts: Record<string, number> = {};
  private failedWaves: { id: string; error: string }[] = [];
  /** Every wave with its reasons to stay, read before the run's record. */
  private allWaves: ExportWaveRow[] = [];

  constructor(
    private readonly source: WavesExportSource,
    private readonly options: WavesExportOptions
  ) {}

  private log(message: string) {
    this.options.log(message);
  }

  private count(key: string, value: number) {
    this.counts[key] = value;
  }

  /** A read, tried again after a pause when it fails (a dropped connection). */
  private async attempt<T>(label: string, read: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        return await read();
      } catch (error) {
        lastError = error;
        if (attempt < ATTEMPTS) {
          this.log(
            `${label}: attempt ${attempt} failed (${String(error)}), trying again`
          );
          const delay = (this.options.retryDelayMs ?? 2_000) * attempt;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  }

  async run(): Promise<WavesExportSummary> {
    const raw = this.options.raw;
    await raw.ensure();
    const startedAt = (this.options.now ?? Date.now)();
    const runs = await raw.load<WavesExportRun[]>(EXPORT_RUNS_FILE, []);
    await this.refuseAnotherFreeze(runs);
    if (this.options.stages.includes('waves')) {
      // Before the run's record, so a records wave the database doesn't
      // have refuses a run without tying the OUT to it.
      this.allWaves = await this.wavesWithRecordsWave();
    }
    runs.push({
      run_started_at: startedAt,
      freeze_ms: this.options.freezeMs,
      exporter_revision: this.options.exporterRevision,
      records_wave_id: this.options.recordsWaveId,
      stages: this.options.stages,
      replica_lag: this.options.replicaLag ?? null
    });
    await raw.save(EXPORT_RUNS_FILE, runs);
    for (const stage of this.options.stages) {
      const stageStart = Date.now();
      this.log(`== ${stage}`);
      await this.runStage(stage);
      this.log(
        `== ${stage} done in ${Math.round((Date.now() - stageStart) / 1000)} s`
      );
    }
    if (!this.options.stages.includes('waves')) {
      // Waves an earlier run could not read, from its waves file, which it
      // wrote whole even when it stopped in a later stage.
      const waves = await raw.load<Record<string, WaveV3>>('waves_v3.json', {});
      this.failedWaves = Object.values(waves)
        .filter((wave) => wave._error)
        .map((wave) => ({ id: wave.id, error: String(wave._error) }));
    }
    const summary: WavesExportSummary = {
      format: WAVES_EXPORT_FORMAT,
      freeze_ms: this.options.freezeMs,
      exporter_revision: this.options.exporterRevision,
      stages: this.options.stages,
      both_metric: this.options.bothMetric,
      counts: sortedKeys(this.counts),
      failed_waves: [...this.failedWaves].sort((a, b) =>
        compareCodePoints(a.id, b.id)
      )
    };
    await raw.save('export.json', {
      ...summary,
      source: "6529.io's database (a read replica at the waves freeze)",
      records_wave_id: this.options.recordsWaveId,
      left_out: await this.leftOut(),
      runs,
      wave_subset: this.options.waveIds,
      started_at: startedAt,
      finished_at: (this.options.now ?? Date.now)()
    });
    return summary;
  }

  /**
   * Refuses a DIR whose earlier runs were for another freeze, or for one they
   * didn't record: a rehearsal's (null), or a run from before the run records
   * (export.json's freeze, else unknown). Its files would mix with this
   * run's: --resume keeps their drops, a run without the waves stage reads
   * their wave list, and drops files of waves gone since stay in the DIR.
   */
  private async refuseAnotherFreeze(runs: WavesExportRun[]): Promise<void> {
    const raw = this.options.raw;
    let earlier: (number | null | undefined)[] = runs.map(
      (run) => run.freeze_ms
    );
    if (!runs.length && raw.exists('export.json')) {
      earlier = [
        (await raw.load<{ freeze_ms?: number | null }>('export.json', {}))
          .freeze_ms
      ];
    } else if (!runs.length && raw.exists('waves_v3.json')) {
      earlier = [undefined];
    }
    const freeze = (ms: number | null | undefined) =>
      ms === undefined
        ? 'a freeze it did not record'
        : ms === null
          ? 'a rehearsal'
          : `the freeze at ${new Date(ms).toISOString()}`;
    const at = earlier.findIndex((ms) => ms !== this.options.freezeMs);
    if (at >= 0) {
      throw new WavesExportUsageError(
        `${raw.root} holds an earlier run for ${freeze(earlier[at])}, and this run ` +
          `is for ${freeze(this.options.freezeMs)}. Their files would mix: ` +
          `its drops of waves gone since would stay, --resume would keep its ` +
          `drops, and a run without the waves stage would read its wave ` +
          `list. Run the export into a new, empty OUT.`,
        { showHelp: false }
      );
    }
    // Which waves stay depends on the records wave: one OUT, one of it.
    const other = runs.find(
      (run) => run.records_wave_id !== this.options.recordsWaveId
    );
    if (other) {
      const kept = (id: string | null | undefined) =>
        id === undefined
          ? 'a records wave it did not record'
          : id === null
            ? 'no records wave'
            : `wave ${id} as the records wave`;
      throw new WavesExportUsageError(
        `${raw.root} holds an earlier run that kept ` +
          `${kept(other.records_wave_id)} on 6529.io, and this run keeps ` +
          `${kept(this.options.recordsWaveId)}. Their files would mix. Run ` +
          `the export into a new, empty OUT, or give the records wave setting ` +
          `the earlier run had.`,
        { showHelp: false }
      );
    }
  }

  /** export.json's `left_out`: what stays on 6529.io, counted by reason. */
  private async leftOut(): Promise<Json> {
    const raw = this.options.raw;
    const staying = await raw.load<Partial<StayingWaves>>(
      STAYING_WAVES_FILE,
      {}
    );
    const groups = await raw.load<Record<string, GroupStayReason>>(
      STAYING_GROUPS_FILE,
      {}
    );
    const waves: Record<string, number> = { total: staying.total ?? 0 };
    for (const reason of STAY_REASONS) {
      waves[reason] = staying.by_reason?.[reason] ?? 0;
    }
    const groupReasons = Object.values(groups);
    const left: Record<string, number> = { total: groupReasons.length };
    for (const reason of GROUP_STAY_REASONS) {
      left[reason] = groupReasons.filter((it) => it === reason).length;
    }
    return { waves, groups: left };
  }

  private async runStage(stage: WavesExportStage): Promise<void> {
    switch (stage) {
      case 'waves':
        return this.stageWaves();
      case 'decisions':
        return this.stageDecisions();
      case 'votes':
        return this.stageVotes();
      case 'logs':
        return this.stageLogs();
      case 'groups':
        return this.stageGroups();
      case 'waverep':
        return this.stageWaveRep();
      case 'polls':
        return this.stagePolls();
      case 'drops':
        return this.stageDrops();
    }
  }

  private async waveIds(): Promise<string[]> {
    const waves =
      await this.options.raw.load<Record<string, WaveV3>>('waves_v3.json');
    return Object.keys(waves)
      .filter((id) => !waves[id]._error)
      .sort(compareCodePoints);
  }

  /**
   * Every wave with its reasons to stay. A run after the freeze refuses when
   * no wave has the records wave's id: a wrong id would let it move. A
   * rehearsal says so and goes on.
   */
  private async wavesWithRecordsWave(): Promise<ExportWaveRow[]> {
    const recordsWaveId = this.options.recordsWaveId;
    const all = await this.source.listWaves({
      recordsWaveId,
      freezeMs: this.options.freezeMs
    });
    // None, on purpose: no wave is the records wave.
    if (
      recordsWaveId !== null &&
      !all.some((wave) => wave.stay_reasons.includes(StayReason.RECORDS_WAVE))
    ) {
      const message =
        `No wave of 6529.io has the records wave's id, ${recordsWaveId} ` +
        `(--records-wave-id or SIGNED_RECORDS_WAVE_ID): check it, or the ` +
        `records wave would move with the rest.`;
      if (this.options.freezeMs !== null) {
        throw new WavesExportUsageError(message, { showHelp: false });
      }
      this.log(`rehearsal: ${message} A run after the freeze refuses on this.`);
    }
    return all;
  }

  private async stageWaves(): Promise<void> {
    const all = this.allWaves;
    const byId = new Map(all.map((wave) => [wave.id, wave]));
    const subset = this.options.waveIds ? new Set(this.options.waveIds) : null;
    const considered = subset ? all.filter((wave) => subset.has(wave.id)) : all;
    // A staying wave is left out whole, from every stage: its configuration,
    // decisions, wave REP, polls, drops, curations and the groups only it
    // names are never read.
    const staying = considered.filter((wave) => wave.stay_reasons.length);
    const rows = considered.filter((wave) => !wave.stay_reasons.length);
    await this.saveStayingWaves(staying);
    const waves: Record<string, WaveV3> = {};
    let failed = 0;
    await forEachLimited(rows, this.options.concurrency, async (wave) => {
      try {
        const configuration = await this.attempt(`wave ${wave.id}`, () =>
          this.source.waveConfiguration(wave, eligibleGroupsForWave(wave, byId))
        );
        // It moves: stays_on_site false, as the API's ApiWave says it (#2553),
        // with its reasons to stay (none) beside it.
        waves[wave.id] = {
          id: wave.id,
          name: configuration.name,
          picture: configuration.picture,
          configuration: { ...configuration, stays_on_site: false },
          stay_reasons: wave.stay_reasons
        } as WaveV3;
      } catch (error) {
        failed++;
        waves[wave.id] = { id: wave.id, _error: String(error) };
        this.failedWaves.push({ id: wave.id, error: String(error) });
        this.log(`wave ${wave.id} not read, left out: ${String(error)}`);
      }
    });
    const exported = new Set(Object.keys(waves));
    const parents: Record<string, string> = {};
    for (const wave of rows) {
      if (wave.parent_wave_id && exported.has(wave.parent_wave_id)) {
        parents[wave.id] = wave.parent_wave_id;
      }
    }
    const roots = rows
      .filter((wave) => !wave.parent_wave_id)
      .map((wave) => ({ id: wave.id }))
      .sort((a, b) => compareCodePoints(a.id, b.id));
    await this.options.raw.save('waves_all.json', roots);
    await this.options.raw.save('waves_v3.json', sortedKeys(waves));
    await this.options.raw.save('subwave_parents.json', sortedKeys(parents));
    // The curations of the waves written, none of a staying wave's: the
    // snapshot builder walks their groups to check every wave moves, and
    // wants an entry for each wave written.
    const written = Object.keys(waves).sort(compareCodePoints);
    const curations: Record<string, ExportCuration[]> = {};
    written.forEach((id) => (curations[id] = []));
    let curationCount = 0;
    for (const curation of await this.source.waveCurations(written)) {
      curations[curation.wave_id]?.push(curation);
      curationCount++;
    }
    await this.options.raw.save(CURATIONS_FILE, sortedKeys(curations));
    this.count('curations', curationCount);
    this.count('waves', rows.length - failed);
    this.count('waves_failed', failed);
    this.count('subwaves', Object.keys(parents).length);
    this.count('waves_staying', staying.length);
    this.log(
      `waves: ${rows.length} (${Object.keys(parents).length} subwaves, ${failed} not read); ${staying.length} stay on 6529.io`
    );
  }

  private async saveStayingWaves(staying: ExportWaveRow[]): Promise<void> {
    const byReason = Object.fromEntries(
      STAY_REASONS.map((reason) => [
        reason,
        staying.filter((wave) => wave.stay_reasons.includes(reason)).length
      ])
    ) as Record<StayReason, number>;
    const waves: Record<string, readonly StayReason[]> = {};
    for (const wave of staying) {
      if (!wave.stay_reasons.includes(StayReason.DIRECT_MESSAGE)) {
        waves[wave.id] = wave.stay_reasons;
      }
    }
    const file: StayingWaves = {
      total: staying.length,
      by_reason: byReason,
      waves: sortedKeys(waves)
    };
    await this.options.raw.save(STAYING_WAVES_FILE, file);
  }

  private async stageDecisions(): Promise<void> {
    const waveIds = await this.waveIds();
    const exported = new Set(waveIds);
    const ids = await this.source.listCompetitionIds(waveIds);
    const competitions: Record<string, Json> = {};
    const details: Record<string, Json> = {};
    let entries = 0;
    await forEachLimited(ids, this.options.concurrency, async (id) => {
      const read = await this.attempt(`decision ${id}`, () =>
        this.source.competition(id)
      );
      if (!read || !exported.has(String(read.competition.wave_id))) return;
      competitions[id] = read.competition;
      details[id] = read.details;
      entries += read.details.entries.length;
    });
    await this.options.raw.save('competitions.json', sortedKeys(competitions));
    await this.options.raw.save(
      'competition_details.json',
      sortedKeys(details)
    );
    this.count('decisions', Object.keys(competitions).length);
    this.count('entries', entries);
    this.log(
      `decisions: ${Object.keys(competitions).length}, entries ${entries}`
    );
  }

  private async loadActiveEntries(): Promise<ExportActiveEntry[]> {
    const raw = this.options.raw;
    return activeEntries(
      await raw.load<Record<string, Json>>('competitions.json'),
      await raw.load<Record<string, { entries: Json[] }>>(
        'competition_details.json'
      )
    );
  }

  private async stageVotes(): Promise<void> {
    const entries = await this.loadActiveEntries();
    const votes: Record<string, Json[]> = {};
    let rows = 0;
    await forEachLimited(entries, this.options.concurrency, async (entry) => {
      votes[entry.entry_id] = await this.attempt(
        `votes of ${entry.entry_id}`,
        () => this.source.entryVotes(entry)
      );
      rows += votes[entry.entry_id].length;
    });
    await this.options.raw.save('entry_votes.json', sortedKeys(votes));
    this.count('vote_rows', rows);
    this.log(`votes: ${entries.length} entries, ${rows} rows`);
  }

  private async stageLogs(): Promise<void> {
    const entries = await this.loadActiveEntries();
    const logs: Record<string, Json[]> = {};
    let rows = 0;
    await forEachLimited(entries, this.options.concurrency, async (entry) => {
      const log = await this.attempt(`vote log of ${entry.drop_id}`, () =>
        this.source.entryVoteLog(entry)
      );
      logs[entry.drop_id] = log.map((row) => ({
        id: row.id,
        voter_profile_id: row.voter_profile_id,
        old_vote: row.old_vote,
        new_vote: row.new_vote,
        created_at: row.created_at
      }));
      rows += log.length;
    });
    await this.options.raw.save('entry_logs.json', sortedKeys(logs));
    this.count('vote_log_rows', rows);
    this.log(`logs: ${entries.length} entries, ${rows} rows`);
  }

  private async stageGroups(): Promise<void> {
    const raw = this.options.raw;
    const waves = await raw.load<Record<string, WaveV3>>('waves_v3.json');
    const competitions = await raw.load<Record<string, Json>>(
      'competitions.json',
      {}
    );
    // The groups the waves that move, their decisions and their curations
    // name: a group only staying waves name is never read.
    const uses = exportedGroups(
      waves,
      competitions,
      await raw.load<Record<string, ExportCuration[]>>(CURATIONS_FILE, {})
    );
    const ids = Array.from(uses.keys()).sort(compareCodePoints);
    const found = await this.source.groups(ids);
    const groups: Record<string, Json> = {};
    const left: Record<string, GroupStayReason> = {};
    for (const id of ids) {
      const group = found[id];
      if (!group) {
        groups[id] = { _error: 404 };
        continue;
      }
      // The rule keeps a staying group's waves on 6529.io (src/waves-scope:
      // hidden, private, a direct message's, or made after the freeze), so
      // a wave that moves names none unless a group changed since: it stays.
      const reason = groupStayReason(group, this.options.freezeMs);
      if (reason) {
        left[id] = reason;
        this.log(
          `group ${id} stays on 6529.io (${reason}) but a wave that moves names it: left out`
        );
        continue;
      }
      groups[id] = group;
    }
    const lists: Record<string, Record<string, string[]>> = {};
    const users: Record<string, string | null> = {};
    for (const id of Object.keys(groups)) {
      const group = groups[id];
      if (group._error) continue;
      const definition = asObject(group.group);
      for (const [which, field] of [
        ['include', 'identity_group_id'],
        ['exclude', 'excluded_identity_group_id']
      ] as const) {
        const identityGroupId = definition[field];
        if (typeof identityGroupId !== 'string' || !identityGroupId) continue;
        const wallets = await this.source.identityGroupWallets(identityGroupId);
        lists[id] = lists[id] ?? {};
        lists[id][which] = wallets
          .map((wallet) => wallet.toLowerCase())
          .sort(compareCodePoints);
      }
      for (const rater of groupRaterKeys(definition)) {
        if (!(rater in users)) {
          users[rater] = await this.source.profileIdOf(rater);
        }
      }
    }
    const members: Record<string, Json[]> = {};
    for (const id of Object.keys(groups)) {
      const group = groups[id];
      if (group._error) continue;
      const definition = asObject(group.group);
      const reasons = groupCriteriaReasons(definition, {
        bothMetric: this.options.bothMetric
      });
      // Every group with a REP or NIC rater too, resolved or not: the
      // snapshot builder checks a rater clause against its members.
      const rated = groupRaterKeys(definition).length > 0;
      if (!reasons.length && !rated) continue;
      members[id] = (await this.source.groupMembers(group)).map((member) => ({
        wallet: (member.wallet ?? '').toLowerCase(),
        key: member.key
      }));
    }
    await raw.save('groups.json', sortedKeys(groups));
    await raw.save('group_lists.json', sortedKeys(lists));
    await raw.save('group_members.json', sortedKeys(members));
    await raw.save('group_users.json', sortedKeys(users));
    await raw.save(STAYING_GROUPS_FILE, sortedKeys(left));
    const written = Object.keys(groups);
    const missing = written.filter((id) => groups[id]._error).length;
    this.count('groups', written.length - missing);
    this.count('groups_missing', missing);
    this.count('groups_as_members', Object.keys(members).length);
    this.count('groups_staying', Object.keys(left).length);
    this.log(
      `groups: ${written.length} (${missing} missing), lists ${Object.keys(lists).length}, as members ${Object.keys(members).length}; ${Object.keys(left).length} stay on 6529.io`
    );
  }

  private async stageWaveRep(): Promise<void> {
    const waveIds = await this.waveIds();
    const ratings = await this.source.waveRep(waveIds);
    const categories: Record<string, Json[]> = {};
    let rows = 0;
    for (const [waveId, waveRatings] of Object.entries(ratings)) {
      rows += waveRatings.length;
      categories[waveId] = Array.from(
        new Set(waveRatings.map((rating) => rating.category))
      )
        .sort(compareCodePoints)
        .map((category) => ({ category }));
    }
    await this.options.raw.save('wave_rep.json', {
      categories: sortedKeys(categories),
      ratings: sortedKeys(ratings)
    });
    this.count('wave_rep_rows', rows);
    this.log(`wave REP: ${rows} rows`);
  }

  private async stagePolls(): Promise<void> {
    const waveIds = await this.waveIds();
    const nowMillis = this.options.freezeMs ?? (this.options.now ?? Date.now)();
    const polls: Record<string, Record<string, Json[]>> = {};
    let count = 0;
    await forEachLimited(waveIds, this.options.concurrency, async (waveId) => {
      for (const state of ['OPEN', 'CLOSED'] as const) {
        const items = await this.attempt(`polls of ${waveId}`, () =>
          this.source.wavePolls(waveId, state, nowMillis)
        );
        if (!items.length) continue;
        polls[waveId] = polls[waveId] ?? {};
        polls[waveId][state] = items;
        count += items.length;
      }
    });
    await this.options.raw.save('polls.json', sortedKeys(polls));
    this.count('polls', count);
    this.log(`polls: ${count} in ${Object.keys(polls).length} waves`);
  }

  private async stageDrops(): Promise<void> {
    const raw = this.options.raw;
    const waveIds = await this.waveIds();
    let drops = 0;
    let signed = 0;
    let done = 0;
    let kept = 0;
    let left = 0;
    await forEachLimited(waveIds, this.options.concurrency, async (waveId) => {
      if (
        this.options.resumeDrops &&
        raw.exists('drops', `${waveId}.jsonl.gz`)
      ) {
        kept++;
        done++;
        return;
      }
      if (this.options.stopBeforeWave?.()) {
        left++;
        return;
      }
      const written = await this.attempt(`drops of ${waveId}`, () =>
        this.exportWaveDrops(waveId)
      );
      drops += written.drops;
      signed += written.signed;
      done++;
      if (done % 100 === 0 || written.drops >= 10_000) {
        this.log(
          `drops: ${done}/${waveIds.length} waves, ${drops} drops, ${signed} signed`
        );
      }
    });
    await raw.ensure('drops');
    if (left) {
      this.log(
        `drops: stopped as asked, ${left} of ${waveIds.length} waves left for a later run (${drops} drops in ${done - kept} waves read)`
      );
      throw new WavesExportStoppedError(left, waveIds.length);
    }
    this.count('drops', drops);
    this.count('signed_drops', signed);
    this.count('drop_waves_kept', kept);
    this.log(
      `drops: ${drops} in ${waveIds.length} waves, ${signed} signed` +
        (kept ? `; ${kept} waves kept from an earlier run` : '')
    );
  }

  /**
   * A wave's drops and signed events, each file put in place only when the
   * whole wave was read: the signed events first, then the drops, so a
   * wave whose drops file exists is complete (what --resume keeps).
   */
  private async exportWaveDrops(
    waveId: string
  ): Promise<{ drops: number; signed: number }> {
    const raw = this.options.raw;
    await raw.remove('signed', `${waveId}.jsonl.gz`);
    const writer = await raw.openJsonLines('drops', `${waveId}.jsonl.gz`);
    const signed: ExportSignedDrop[] = [];
    try {
      for await (const page of this.source.wavePagesOfDrops(
        waveId,
        this.options.dropPageSize
      )) {
        for (const drop of page) {
          const row = compactDrop(drop);
          row.wave_id = row.wave_id || waveId;
          await writer.write(row);
        }
        const authorSigned = page.filter((drop) => !!drop.is_author_signed);
        for (let i = 0; i < authorSigned.length; i += SIGNED_BATCH) {
          signed.push(
            ...(await this.source.signedEvents(
              authorSigned.slice(i, i + SIGNED_BATCH)
            ))
          );
        }
      }
      const signedWriter = await raw.openJsonLines(
        'signed',
        `${waveId}.jsonl.gz`
      );
      try {
        for (const item of signed.sort((a, b) =>
          compareCodePoints(a.drop_id, b.drop_id)
        )) {
          await signedWriter.write(item);
        }
        await signedWriter.commit();
      } catch (error) {
        await signedWriter.abort();
        throw error;
      }
      await writer.commit();
    } catch (error) {
      await writer.abort();
      throw error;
    }
    return { drops: writer.count, signed: signed.length };
  }
}
