import {
  affectedRows,
  BackupSink,
  BatchOptions,
  batchSettings,
  BatchSettings,
  chunk,
  compareStrings,
  currentDatabase,
  identifier,
  inTransaction,
  pause,
  placeholders,
  retryOnLockConflict,
  sha256Lines,
  SqlRunner,
  withNamedLock
} from './operator-sql';

// Operator-only removal of the empty `id-0x…` shell profiles that bulk rating auto-created for
// wallets which never used the platform. A shell is removed only when nothing outside its own
// rows refers to it: the plan scans every id-like column of every application table.

export interface ShellProfile {
  profile_id: string;
  address: string;
}

export interface ReferenceColumn {
  table: string;
  column: string;
  kind: 'profile' | 'address';
  method: 'distinct' | 'lookup';
}

export interface ShellProfileCleanupPlan {
  version: 1;
  database: string;
  planned_at: number;
  source_targets_sha256: string;
  shells_sha256: string;
  counts: {
    source_targets: number;
    shell_candidates: number;
    referenced_elsewhere: number;
    shells: number;
  };
  referenced_by: Record<string, number>;
  scanned_columns: string[];
  ignored_tables: string[];
}

export interface ShellProfileCleanupResult {
  shells_deleted: number;
  shells_skipped: number;
  rows_deleted: Record<string, number>;
}

const LOCK_NAME = 'cleanup-shell-profiles-v1';
const DEFAULT_BATCH_SIZE = 500;
const LOOKUP_CHUNK = 2000;
const SMALL_TABLE_ROWS = 300_000;

/** The only activity a never-used shell has: its own automatic creation. */
export const SHELL_LOG_TYPES = [
  'PROFILE_CREATED',
  'HANDLE_EDIT',
  'CLASSIFICATION_EDIT'
] as const;

/** Rows that belong to the shell itself and are removed with it. */
const OWN_COLUMNS = new Set([
  'profiles.external_id',
  'profiles_archive.external_id',
  'identities.profile_id',
  'profile_latest_logs.profile_id',
  'profile_total_rep_score_aggregations.profile_id',
  'profile_activity_logs.profile_id'
]);

/** App tables keyed by wallet or consolidation key that show a wallet really used the platform. */
export const ADDRESS_REFERENCES: readonly { table: string; column: string }[] =
  [
    { table: 'refresh_tokens', column: 'address' },
    { table: 'wallet_auth_sessions', column: 'address' },
    { table: 'subscriptions_balances', column: 'consolidation_key' },
    { table: 'subscriptions_mode', column: 'consolidation_key' },
    { table: 'subscriptions_logs', column: 'consolidation_key' },
    { table: 'subscriptions_nfts', column: 'consolidation_key' },
    { table: 'subscriptions_redeemed', column: 'consolidation_key' },
    { table: 'subscriptions_top_up', column: 'from_wallet' },
    {
      table: 'subscription_coverage_alert_states',
      column: 'consolidation_key'
    },
    {
      table: 'subscription_coverage_refresh_requests',
      column: 'consolidation_key'
    }
  ];

/** Ad-hoc copies and scratch tables that no code reads. */
const IGNORED_TABLE_PATTERNS = [
  /(^|_)(bckp|bckup|backup)(_|$)/i,
  /^analysis_/i,
  /^pfa_temp$/i,
  /^ppp2$/i
];

const UUID_LIKE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isIgnoredTable(table: string): boolean {
  return IGNORED_TABLE_PATTERNS.some((pattern) => pattern.test(table));
}

/** Rows a never-used bulk-rating shell has, and nothing else. */
const SHELL_PREDICATE = `p.normalised_handle = CONCAT('id-', i.primary_address)
  AND p.primary_wallet = i.primary_address AND i.consolidation_key = i.primary_address
  AND p.pfp_url IS NULL AND p.banner_1 IS NULL AND p.banner_2 IS NULL AND p.website IS NULL
  AND i.pfp IS NULL AND i.banner1 IS NULL AND i.banner2 IS NULL
  AND i.tdh = 0 AND i.xtdh = 0 AND i.cic = 0 AND i.rep = 0 AND i.level_raw = 0
  AND i.produced_xtdh = 0 AND i.granted_xtdh = 0`;

async function selectShells(
  runner: SqlRunner,
  profileIds: readonly string[],
  lock: boolean
): Promise<ShellProfile[]> {
  return runner.query(
    `SELECT p.external_id AS profile_id, i.primary_address AS address
     FROM profiles p JOIN identities i ON i.profile_id = p.external_id
     WHERE p.external_id IN (${placeholders(profileIds)}) AND ${SHELL_PREDICATE}
     ORDER BY p.external_id ${lock ? 'FOR UPDATE' : ''}`,
    [...profileIds]
  );
}

interface ColumnInfo {
  table: string;
  column: string;
  rows: number;
  leadsIndex: boolean;
}

async function listIdColumns(runner: SqlRunner): Promise<ColumnInfo[]> {
  const rows: {
    table_name: string;
    column_name: string;
    table_rows: string | number | null;
    leads_index: string | number;
  }[] = await runner.query(
    `SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, t.TABLE_ROWS AS table_rows,
            EXISTS (SELECT 1 FROM information_schema.STATISTICS s
                    WHERE s.TABLE_SCHEMA = c.TABLE_SCHEMA AND s.TABLE_NAME = c.TABLE_NAME
                      AND s.COLUMN_NAME = c.COLUMN_NAME AND s.SEQ_IN_INDEX = 1) AS leads_index
     FROM information_schema.COLUMNS c
     JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
     WHERE c.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE'
       AND c.DATA_TYPE IN ('varchar', 'char') AND c.CHARACTER_MAXIMUM_LENGTH >= 36
     ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`
  );
  return rows.map((row) => ({
    table: row.table_name,
    column: row.column_name,
    rows: Number(row.table_rows ?? 0),
    leadsIndex: Number(row.leads_index) === 1
  }));
}

async function holdsUuids(runner: SqlRunner, info: ColumnInfo) {
  if (info.rows <= SMALL_TABLE_ROWS) return true;
  const sample: { value: string }[] = await runner.query(
    `SELECT ${identifier(info.column)} AS value FROM ${identifier(info.table)}
     WHERE ${identifier(info.column)} IS NOT NULL LIMIT 200`
  );
  return sample.some((row) => UUID_LIKE.test(String(row.value)));
}

/** Every column outside the shell's own rows that can hold a profile id or a used wallet. */
export async function discoverReferenceColumns(
  runner: SqlRunner
): Promise<{ columns: ReferenceColumn[]; ignoredTables: string[] }> {
  const all = await listIdColumns(runner);
  const tables = new Set(all.map((info) => info.table));
  const ignoredTables = Array.from(tables)
    .filter(isIgnoredTable)
    .sort(compareStrings);
  const columns: ReferenceColumn[] = [];
  for (const info of all) {
    const key = `${info.table}.${info.column}`;
    if (
      isIgnoredTable(info.table) ||
      OWN_COLUMNS.has(key) ||
      info.column === 'id' ||
      !(await holdsUuids(runner, info))
    ) {
      continue;
    }
    columns.push({
      table: info.table,
      column: info.column,
      kind: 'profile',
      method:
        info.rows > SMALL_TABLE_ROWS && info.leadsIndex ? 'lookup' : 'distinct'
    });
  }
  for (const ref of ADDRESS_REFERENCES) {
    if (tables.has(ref.table)) {
      columns.push({ ...ref, kind: 'address', method: 'distinct' });
    }
  }
  return { columns, ignoredTables };
}

async function referencedValues(
  runner: SqlRunner,
  ref: ReferenceColumn,
  values: readonly string[]
): Promise<Set<string>> {
  const column = identifier(ref.column);
  const table = identifier(ref.table);
  const found = new Set<string>();
  if (ref.method === 'distinct') {
    const wanted = new Set(values);
    const rows: { value: string }[] = await runner.query(
      `SELECT DISTINCT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`
    );
    for (const row of rows) {
      const value = String(row.value).toLowerCase();
      if (wanted.has(value)) found.add(value);
    }
    return found;
  }
  for (const part of chunk(values, LOOKUP_CHUNK)) {
    const rows: { value: string }[] = await runner.query(
      `SELECT DISTINCT ${column} AS value FROM ${table} WHERE ${column} IN (${placeholders(part)})`,
      part
    );
    for (const row of rows) found.add(String(row.value).toLowerCase());
  }
  return found;
}

/** Shells whose own rows show more than automatic creation. */
async function shellsWithOwnActivity(
  runner: SqlRunner,
  profileIds: readonly string[]
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const part of chunk(profileIds, LOOKUP_CHUNK)) {
    const logs: { id: string }[] = await runner.query(
      `SELECT DISTINCT profile_id AS id FROM profile_activity_logs
       WHERE profile_id IN (${placeholders(part)}) AND type NOT IN (${placeholders(SHELL_LOG_TYPES)})`,
      [...part, ...SHELL_LOG_TYPES]
    );
    const scores: { id: string }[] = await runner.query(
      `SELECT profile_id AS id FROM profile_total_rep_score_aggregations
       WHERE profile_id IN (${placeholders(part)}) AND (score <> 0 OR rater_count <> 0)`,
      part
    );
    for (const row of [...logs, ...scores]) found.add(row.id.toLowerCase());
  }
  return found;
}

async function findShellCandidates(
  runner: SqlRunner,
  targets: readonly string[],
  log: (message: string) => void
): Promise<ShellProfile[]> {
  const shells: ShellProfile[] = [];
  for (const part of chunk(targets, LOOKUP_CHUNK)) {
    shells.push(...(await selectShells(runner, part, false)));
    log(`candidates: ${shells.length}`);
  }
  return shells;
}

/** Read-only. `targets` are the profile ids the proxy REP rollback touched. */
export async function inspectShellProfileCleanup(
  runner: SqlRunner,
  targets: readonly string[],
  options: BatchOptions = {}
): Promise<{ plan: ShellProfileCleanupPlan; shells: ShellProfile[] }> {
  const { log } = batchSettings(options, DEFAULT_BATCH_SIZE);
  const database = await currentDatabase(runner);
  const plannedAt = Date.now();
  const candidates = await findShellCandidates(runner, targets, log);
  const profileIds = candidates.map((shell) => shell.profile_id.toLowerCase());
  const addresses = candidates.map((shell) => shell.address.toLowerCase());
  const excluded = new Set<string>();
  const referencedBy: Record<string, number> = {};
  const own = await shellsWithOwnActivity(runner, profileIds);
  if (own.size) referencedBy['own activity'] = own.size;
  own.forEach((id) => excluded.add(id));
  const { columns, ignoredTables } = await discoverReferenceColumns(runner);
  const profileByAddress = new Map(
    candidates.map((shell) => [
      shell.address.toLowerCase(),
      shell.profile_id.toLowerCase()
    ])
  );
  for (const ref of columns) {
    const values = ref.kind === 'profile' ? profileIds : addresses;
    const hits = await referencedValues(runner, ref, values);
    if (!hits.size) continue;
    referencedBy[`${ref.table}.${ref.column}`] = hits.size;
    hits.forEach((hit) => {
      excluded.add(
        ref.kind === 'profile' ? hit : (profileByAddress.get(hit) ?? hit)
      );
    });
    log(`${ref.table}.${ref.column}: ${hits.size} shells referenced`);
  }
  const shells = candidates
    .filter((shell) => !excluded.has(shell.profile_id.toLowerCase()))
    .sort((a, b) => compareStrings(a.profile_id, b.profile_id));
  return {
    plan: {
      version: 1,
      database,
      planned_at: plannedAt,
      source_targets_sha256: sha256Lines(targets),
      shells_sha256: sha256Lines(shells.map(shellLine)),
      counts: {
        source_targets: targets.length,
        shell_candidates: candidates.length,
        referenced_elsewhere: candidates.length - shells.length,
        shells: shells.length
      },
      referenced_by: referencedBy,
      scanned_columns: columns.map((ref) => `${ref.table}.${ref.column}`),
      ignored_tables: ignoredTables
    },
    shells
  };
}

export function shellLine(shell: ShellProfile): string {
  return `${shell.profile_id}\t${shell.address}`;
}

export function parseShellLine(line: string): ShellProfile {
  const [profileId, address, ...rest] = line.split('\t');
  if (!profileId || !address || rest.length) {
    throw new Error(`Malformed shell line: ${line}`);
  }
  return { profile_id: profileId, address };
}

/** Activity that can appear between planning and execution, rechecked under lock. */
async function recentlyUsed(
  runner: SqlRunner,
  shells: readonly ShellProfile[]
): Promise<Set<string>> {
  const ids = shells.map((shell) => shell.profile_id);
  const addresses = shells.map((shell) => shell.address);
  const byAddress = new Map(
    shells.map((shell) => [shell.address, shell.profile_id])
  );
  const used = await shellsWithOwnActivity(runner, ids);
  const checks: {
    sql: string;
    values: readonly string[];
    address?: boolean;
  }[] = [
    {
      sql: 'SELECT DISTINCT target_id AS v FROM profile_activity_logs WHERE target_id IN',
      values: ids
    },
    {
      sql: 'SELECT DISTINCT matter_target_id AS v FROM ratings WHERE matter_target_id IN',
      values: ids
    },
    {
      sql: 'SELECT DISTINCT rater_profile_id AS v FROM ratings WHERE rater_profile_id IN',
      values: ids
    },
    {
      sql: 'SELECT DISTINCT identity_id AS v FROM identity_notifications WHERE identity_id IN',
      values: ids
    },
    {
      sql: 'SELECT DISTINCT subscriber_id AS v FROM identity_subscriptions WHERE subscriber_id IN',
      values: ids
    },
    {
      sql: 'SELECT DISTINCT target_id AS v FROM identity_subscriptions WHERE target_id IN',
      values: ids
    },
    {
      sql: 'SELECT DISTINCT author_id AS v FROM drops WHERE author_id IN',
      values: ids
    },
    {
      sql: 'SELECT DISTINCT address AS v FROM refresh_tokens WHERE address IN',
      values: addresses,
      address: true
    },
    {
      sql: 'SELECT DISTINCT address AS v FROM wallet_auth_sessions WHERE address IN',
      values: addresses,
      address: true
    }
  ];
  for (const check of checks) {
    const rows: { v: string }[] = await runner.query(
      `${check.sql} (${placeholders(check.values)})`,
      [...check.values]
    );
    for (const row of rows) {
      const value = String(row.v).toLowerCase();
      used.add(check.address ? (byAddress.get(value) ?? value) : value);
    }
  }
  return used;
}

async function deleteShellBatch(
  runner: SqlRunner,
  planned: readonly ShellProfile[],
  sink: BackupSink
): Promise<{ deleted: number; skipped: number; rows: Record<string, number> }> {
  return inTransaction(runner, async () => {
    const still = await selectShells(
      runner,
      planned.map((shell) => shell.profile_id),
      true
    );
    const used = await (still.length
      ? recentlyUsed(runner, still)
      : new Set<string>());
    const shells = still.filter(
      (shell) => !used.has(shell.profile_id.toLowerCase())
    );
    const rows: Record<string, number> = {};
    if (!shells.length) {
      return { deleted: 0, skipped: planned.length, rows };
    }
    const ids = shells.map((shell) => shell.profile_id);
    const addresses = shells.map((shell) => shell.address);
    const statements: { table: string; where: string; params: unknown[] }[] = [
      {
        table: 'profile_activity_logs',
        where: `profile_id IN (${placeholders(ids)}) AND type IN (${placeholders(SHELL_LOG_TYPES)})`,
        params: [...ids, ...SHELL_LOG_TYPES]
      },
      {
        table: 'profile_latest_logs',
        where: `profile_id IN (${placeholders(ids)})`,
        params: ids
      },
      {
        table: 'profile_total_rep_score_aggregations',
        where: `profile_id IN (${placeholders(ids)}) AND score = 0 AND rater_count = 0`,
        params: ids
      },
      {
        table: 'profiles_archive',
        where: `external_id IN (${placeholders(ids)})`,
        params: ids
      },
      {
        table: 'profiles',
        where: `external_id IN (${placeholders(ids)})`,
        params: ids
      },
      {
        table: 'address_consolidation_keys',
        where: `address IN (${placeholders(addresses)}) AND consolidation_key IN (${placeholders(addresses)})`,
        params: [...addresses, ...addresses]
      },
      {
        table: 'identities',
        where: `profile_id IN (${placeholders(ids)}) AND consolidation_key IN (${placeholders(addresses)})`,
        params: [...ids, ...addresses]
      }
    ];
    for (const statement of statements) {
      const table = identifier(statement.table);
      sink.write(
        statement.table,
        await runner.query(
          `SELECT * FROM ${table} WHERE ${statement.where}`,
          statement.params
        )
      );
      rows[statement.table] = affectedRows(
        await runner.query(
          `DELETE FROM ${table} WHERE ${statement.where}`,
          statement.params
        )
      );
    }
    return {
      deleted: shells.length,
      skipped: planned.length - shells.length,
      rows
    };
  });
}

async function verifyShellPlan(
  runner: SqlRunner,
  plan: ShellProfileCleanupPlan,
  shells: readonly ShellProfile[]
) {
  if ((await currentDatabase(runner)) !== plan.database) {
    throw new Error('Plan database mismatch');
  }
  if (sha256Lines(shells.map(shellLine)) !== plan.shells_sha256) {
    throw new Error('Shell list does not match the plan');
  }
}

/** Called only by the explicit operator CLI with an approved plan. Safe to re-run after a failure. */
export async function executeShellProfileCleanup(
  runner: SqlRunner,
  plan: ShellProfileCleanupPlan,
  shells: readonly ShellProfile[],
  sink: BackupSink,
  options: BatchOptions = {}
): Promise<ShellProfileCleanupResult> {
  const settings: BatchSettings = batchSettings(options, DEFAULT_BATCH_SIZE);
  return withNamedLock(runner, LOCK_NAME, async () => {
    await verifyShellPlan(runner, plan, shells);
    const result: ShellProfileCleanupResult = {
      shells_deleted: 0,
      shells_skipped: 0,
      rows_deleted: {}
    };
    for (const batch of chunk(shells, settings.batchSize)) {
      const done = await retryOnLockConflict(() =>
        deleteShellBatch(runner, batch, sink)
      );
      result.shells_deleted += done.deleted;
      result.shells_skipped += done.skipped;
      for (const [table, count] of Object.entries(done.rows)) {
        result.rows_deleted[table] = (result.rows_deleted[table] ?? 0) + count;
      }
      settings.log(
        `shells: deleted ${result.shells_deleted}, skipped ${result.shells_skipped}`
      );
      await pause(settings.pauseMs);
    }
    return result;
  });
}
