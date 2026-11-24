import {
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITIONS_TABLE,
  DROPS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { DbPoolName, DbQueryOptions } from '@/db-query.options';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  CHAIN_INDEX_STATE_TABLE_NAME,
  CHAIN_NETWORK_ID_ENV,
  CHAIN_WAVES_TABLE_NAME,
  chainIndexReady,
  expectedChainNetwork,
  waveOnChainSql
} from '@/waves-chain-index/waves-chain-mapping';
import {
  isWavesSwitchedOn,
  wavesConfigured,
  wavesFreezeAtMs
} from '@/waves-freeze/waves-freeze';
import {
  ChainStateSql,
  movingWaveUsesGroupsSql,
  readRecordsWaveSetting,
  RECORDS_WAVE_ID_ENV,
  SCOPE_SQL_PARAMS,
  scopeFromRow,
  WaveScope,
  wavesScopeSql
} from '@/waves-scope/waves-scope';

const logger = Logger.get('WAVES_SCOPE');

/** Logged once per cold start when SIGNED_RECORDS_WAVE_ID is `none`. */
export const RECORDS_NONE_MESSAGE = `[${RECORDS_WAVE_ID_ENV} IS none] [6529.IO HAS NO RECORDS WAVE]`;
/** Logged once per cold start when SIGNED_RECORDS_WAVE_ID is unset. */
export const RECORDS_UNSET_MESSAGE = `[${RECORDS_WAVE_ID_ENV} IS NOT SET] [SET IT TO THE RECORDS WAVE'S ID, OR TO none] [NO WAVE STAYS AS THE RECORDS WAVE UNTIL THEN]`;
/** Logged once per cold start when WAVES_SETTLEMENT_NETWORK_ID is unset. */
export const NETWORK_UNSET_MESSAGE = `[${CHAIN_NETWORK_ID_ENV} IS NOT SET] [SET IT TO THE 6529 CHAIN'S NETWORK ID] [AFTER THE SWITCH-ON THE RULE STILL DECIDES UNTIL THEN]`;
/** Logged once per cold start when switched on before the chain index's tables exist. */
export const CHAIN_TABLES_MISSING_MESSAGE = `[THE WAVES CHAIN INDEX'S TABLES ARE MISSING] [SWITCHED ON, BUT THE RULE STILL DECIDES UNTIL THE CHAIN INDEX IS DEPLOYED AND READY]`;

/** Where the scope's start-up lines go. */
export interface ScopeLog {
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
}

const LOGGER_LOG: ScopeLog = {
  info: (message) => logger.info(message),
  warn: (message) => logger.warn(message),
  error: (message) => logger.error(message)
};

/**
 * Reports the settings the waves scope reads, once per process (a cold
 * start): SIGNED_RECORDS_WAVE_ID `none` as information, and an unset
 * SIGNED_RECORDS_WAVE_ID or WAVES_SETTLEMENT_NETWORK_ID by name. Ops sets
 * the records wave's id or none, and the network id. An unset one is an
 * error, which alerts as an operational error, only once a waves setting
 * is configured (wavesConfigured); until then it is a warning.
 */
export function wavesSettingsReporter(
  log: ScopeLog
): (env: Readonly<Record<string, string | undefined>>) => void {
  let reported = false;
  return (env) => {
    if (reported) return;
    reported = true;
    const missing = wavesConfigured(env)
      ? (message: string) => log.error(message)
      : (message: string) => log.warn(message);
    const records = readRecordsWaveSetting(env);
    if (records.kind === 'none') log.info(RECORDS_NONE_MESSAGE);
    if (records.kind === 'unset') missing(RECORDS_UNSET_MESSAGE);
    if (expectedChainNetwork(env) === null) missing(NETWORK_UNSET_MESSAGE);
  };
}

/** The values of the SQL form's named parameters (SCOPE_SQL_PARAMS). */
export function scopeSqlParamValues(): Record<string, unknown> {
  const freezeAtMs = wavesFreezeAtMs();
  const records = readRecordsWaveSetting(process.env);
  return {
    [SCOPE_SQL_PARAMS.records]: records.kind === 'id' ? records.id : null,
    [SCOPE_SQL_PARAMS.freezeAtMs]: freezeAtMs,
    [SCOPE_SQL_PARAMS.freezeAt]:
      freezeAtMs === null ? null : new Date(freezeAtMs)
  };
}

const MAPPER_CACHE_MS = 60_000;
const MAPPER_CACHE_MAX_WAVES = 50_000;
/** How long a process reuses its reading of the chain index's readiness. */
export const CHAIN_READINESS_CACHE_MS = 30_000;
/**
 * The most wave ids one scope statement carries. With 100 ids a
 * statement stays under RDS Proxy's 16,000 bytes, past which it pins the
 * session (src/db/proxy-session-pinning.ts).
 */
export const SCOPE_WAVE_IDS_PER_STATEMENT = 100;
/** The most group ids one usedByMovingWave statement carries, likewise. */
export const SCOPE_GROUP_IDS_PER_STATEMENT = 10;

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    chunks.push(items.slice(i, i + size));
  return chunks;
}

/** A decision's wave, legacy wave and capabilities. */
export interface DecisionRef {
  readonly wave_id: string;
  readonly legacy_wave_id: string | null;
  readonly capabilities: readonly string[];
}

/**
 * Reads which waves stay on 6529.io and which move to the 6529 chain
 * (src/waves-scope/waves-scope.ts holds the rule). Guards read the primary,
 * or the transaction's connection, so a write a moment ago is seen.
 *
 * Before the switch-on (WAVES_SWITCH_ON_AT, FEATURE_WAVES_ON_CHAIN) the rule
 * decides, with the freeze time from WAVES_FREEZE_AT. After it, once the
 * chain index is ready (src/waves-chain-index/waves-chain-mapping.ts), a
 * wave stays unless the chain holds it. Until the index is ready the rule
 * still decides, and only a wave made on the chain has moved, so a switch-on
 * time set too early opens no moving wave. The index counts as ready only
 * on the network WAVES_SETTLEMENT_NETWORK_ID names: with it unset, nothing
 * is ready. Missing chain index tables read as not ready, without a failed
 * statement. A process reuses its reading of readiness for
 * CHAIN_READINESS_CACHE_MS, so a change shows within that time.
 */
export class WavesScopeService extends LazyDbAccessCompatibleService {
  private readonly mapperCache = new Map<
    string,
    { scope: WaveScope; until: number }
  >();

  private readiness: {
    readonly network: string;
    readonly ready: boolean;
    readonly until: number;
  } | null = null;
  private reportedMissingTables = false;
  private readonly reportSettings: (
    env: Readonly<Record<string, string | undefined>>
  ) => void;
  private readonly readinessCacheMs: number;
  private readonly log: ScopeLog;

  constructor(
    sqlExecutorGetter: typeof dbSupplier,
    private readonly switchedOn: () => boolean = () => isWavesSwitchedOn(),
    {
      readinessCacheMs = CHAIN_READINESS_CACHE_MS,
      log = LOGGER_LOG
    }: { readonly readinessCacheMs?: number; readonly log?: ScopeLog } = {}
  ) {
    super(sqlExecutorGetter);
    this.readinessCacheMs = readinessCacheMs;
    this.log = log;
    this.reportSettings = wavesSettingsReporter(log);
  }

  /**
   * Guards read the transaction's connection, or the primary, so a write a
   * moment ago is seen. The API's display reads may use the replica.
   */
  private options(ctx: RequestContext, replica = false): DbQueryOptions {
    if (ctx.connection) return { wrappedConnection: ctx.connection };
    return replica ? {} : { forcePool: DbPoolName.WRITE };
  }

  /** The chain's state, for the SQL form. */
  private async chainStateSql(options: DbQueryOptions): Promise<ChainStateSql> {
    this.reportSettings(process.env);
    if (!this.switchedOn()) return { switchedOn: false };
    // Ready: the index has finished a full read on the expected network
    // (WAVES_SETTLEMENT_NETWORK_ID). It starts one only after the chain's
    // waves import completed, so before that the rule still decides. With
    // no expected network, no chain's read counts.
    const network = expectedChainNetwork();
    if (network === null) return { switchedOn: true, heldSql: null };
    const ready = await this.chainIndexReady(network, options);
    return { switchedOn: true, heldSql: ready ? waveOnChainSql : null };
  }

  /** chainIndexReady, reused for readinessCacheMs, and quiet on missing tables. */
  private async chainIndexReady(
    network: string,
    options: DbQueryOptions
  ): Promise<boolean> {
    const now = Date.now();
    const cached = this.readiness;
    if (cached && cached.network === network && cached.until > now)
      return cached.ready;
    const ready =
      (await this.chainIndexTablesExist(options)) &&
      (await chainIndexReady(this.db, options, network));
    this.readiness = { network, ready, until: now + this.readinessCacheMs };
    return ready;
  }

  /**
   * Whether the chain index's two tables exist, asked of the data
   * dictionary, so a missing table is no failed statement (which the
   * executor would log on every scope read).
   */
  private async chainIndexTablesExist(
    options: DbQueryOptions
  ): Promise<boolean> {
    const row = await this.db.oneOrNull<{ tables: number | string }>(
      `select count(*) as tables from information_schema.tables where table_schema = database() and table_name in (:names)`,
      { names: [CHAIN_INDEX_STATE_TABLE_NAME, CHAIN_WAVES_TABLE_NAME] },
      options
    );
    const exist = Number(row?.tables ?? 0) === 2;
    if (!exist && !this.reportedMissingTables) {
      this.reportedMissingTables = true;
      this.log.error(CHAIN_TABLES_MISSING_MESSAGE);
    }
    return exist;
  }

  /** The scope of each existing wave; a wave id with no row is absent. */
  async waveScopes(
    waveIds: string[],
    ctx: RequestContext,
    { replica = false }: { readonly replica?: boolean } = {}
  ): Promise<Map<string, WaveScope>> {
    const ids = Array.from(new Set(waveIds.filter(Boolean)));
    const scopes = new Map<string, WaveScope>();
    if (!ids.length) return scopes;
    const params = scopeSqlParamValues();
    const options = this.options(ctx, replica);
    const chain = await this.chainStateSql(options);
    const select = wavesScopeSql('w', chain).select;
    const recordsWaveConfigured =
      readRecordsWaveSetting(process.env).kind !== 'unset';
    for (const chunk of chunked(ids, SCOPE_WAVE_IDS_PER_STATEMENT)) {
      const rows = await this.db.execute<
        { id: string } & Record<string, unknown>
      >(
        `${select} where w.id in (:waveIds)`,
        { ...params, waveIds: chunk },
        options
      );
      for (const row of rows) {
        scopes.set(row.id, scopeFromRow(row, { chain, recordsWaveConfigured }));
      }
    }
    return scopes;
  }

  /**
   * Whether the wave stays on 6529.io. A wave id with no row moves: a write
   * to it fails on its own, and the freeze must not be the thing that lets
   * it through.
   */
  async waveStays(
    waveId: string | null | undefined,
    ctx: RequestContext
  ): Promise<boolean> {
    if (!waveId) return false;
    return (await this.waveScopes([waveId], ctx)).get(waveId)?.stays ?? false;
  }

  /** The waves among these that move (missing ids included). */
  async movingWaveIds(
    waveIds: string[],
    ctx: RequestContext
  ): Promise<Set<string>> {
    const scopes = await this.waveScopes(waveIds, ctx);
    return new Set(waveIds.filter((id) => !(scopes.get(id)?.stays ?? false)));
  }

  /** The wave of a drop, or null when there is no such drop. */
  async dropWaveId(
    dropId: string,
    ctx: RequestContext
  ): Promise<string | null> {
    const row = await this.db.oneOrNull<{ wave_id: string }>(
      `select wave_id from ${DROPS_TABLE} where id = :dropId`,
      { dropId },
      this.options(ctx)
    );
    return row?.wave_id ?? null;
  }

  /** The wave of a decision, or null when there is no such decision. */
  async decisionWaveId(
    competitionId: string,
    ctx: RequestContext
  ): Promise<string | null> {
    const row = await this.db.oneOrNull<{ wave_id: string }>(
      `select wave_id from ${COMPETITIONS_TABLE} where id = :competitionId`,
      { competitionId },
      this.options(ctx)
    );
    return row?.wave_id ?? null;
  }

  /**
   * What the freeze needs to know of these decisions: each one's wave, its
   * legacy wave and its capabilities (the Main Stage has MAIN_STAGE). A
   * decision id with no row is absent.
   */
  async decisionRefs(
    competitionIds: string[],
    ctx: RequestContext
  ): Promise<Map<string, DecisionRef>> {
    const ids = Array.from(new Set(competitionIds.filter(Boolean)));
    const refs = new Map<string, DecisionRef>();
    if (!ids.length) return refs;
    const rows = await this.db.execute<{
      id: string;
      wave_id: string;
      legacy_wave_id: string | null;
      capability: string | null;
    }>(
      `select c.id, c.wave_id, c.legacy_wave_id, cc.capability from ${COMPETITIONS_TABLE} c left join ${COMPETITION_CAPABILITIES_TABLE} cc on cc.competition_id = c.id where c.id in (:ids)`,
      { ids },
      this.options(ctx)
    );
    for (const row of rows) {
      const ref = refs.get(row.id) ?? {
        wave_id: row.wave_id,
        legacy_wave_id: row.legacy_wave_id,
        capabilities: []
      };
      refs.set(row.id, {
        ...ref,
        capabilities: row.capability
          ? [...ref.capabilities, row.capability]
          : ref.capabilities
      });
    }
    return refs;
  }

  /**
   * Whether a wave that moves uses one of these groups (as its visibility,
   * admin, chat, hub, curation or decision group): the waves freeze holds
   * such a group. After the switch-on, the waves that move are the ones the
   * chain holds.
   */
  async usedByMovingWave(
    groupIds: string[],
    ctx: RequestContext
  ): Promise<boolean> {
    const ids = Array.from(new Set(groupIds.filter(Boolean)));
    if (!ids.length) return false;
    const options = this.options(ctx);
    const chain = await this.chainStateSql(options);
    const sql = `select exists (select 1 from ${WAVES_TABLE} w where ${movingWaveUsesGroupsSql('w', 'groupIds', chain)}) as used`;
    for (const chunk of chunked(ids, SCOPE_GROUP_IDS_PER_STATEMENT)) {
      const row = await this.db.oneOrNull<{ used: number | string }>(
        sql,
        { ...scopeSqlParamValues(), groupIds: chunk },
        options
      );
      if (Number(row?.used ?? 0) === 1) return true;
    }
    return false;
  }

  /**
   * For the API's stays_on_site: like waveScopes, read from the replica
   * through a short-lived cache (a minute). Guards never use it. A wave id
   * with no row moves. Inside a transaction it reads the transaction's
   * connection and caches nothing, since the transaction may roll back.
   */
  async staysForDisplay(
    waveIds: string[],
    ctx: RequestContext
  ): Promise<Map<string, boolean>> {
    const now = Date.now();
    const result = new Map<string, boolean>();
    const missing: string[] = [];
    for (const id of Array.from(new Set(waveIds.filter(Boolean)))) {
      const cached = this.mapperCache.get(id);
      if (cached && cached.until > now) result.set(id, cached.scope.stays);
      else missing.push(id);
    }
    if (missing.length) {
      const scopes = await this.waveScopes(
        missing,
        { timer: ctx.timer, connection: ctx.connection },
        { replica: true }
      );
      if (this.mapperCache.size > MAPPER_CACHE_MAX_WAVES)
        this.mapperCache.clear();
      for (const id of missing) {
        const scope = scopes.get(id);
        result.set(id, scope?.stays ?? false);
        if (scope && !ctx.connection)
          this.mapperCache.set(id, { scope, until: now + MAPPER_CACHE_MS });
      }
    }
    return result;
  }
}

export const wavesScopeService = new WavesScopeService(dbSupplier);
