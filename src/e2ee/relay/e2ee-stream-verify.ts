import {
  E2EE_BACKUP_CHUNKS_TABLE,
  E2EE_BACKUPS_TABLE,
  E2EE_BLOB_CHUNKS_TABLE,
  E2EE_BLOBS_TABLE,
  E2EE_CIPHERTEXT_OBJECTS_TABLE,
  E2EE_DEVICES_TABLE,
  E2EE_GROUP_EPOCHS_TABLE,
  E2EE_GROUP_ROSTER_TABLE,
  E2EE_GROUPS_TABLE,
  E2EE_KEY_PACKAGES_TABLE,
  E2EE_LOG_TABLE,
  E2EE_WELCOME_DELIVERIES_TABLE,
  E2EE_WELCOMES_TABLE
} from '@/constants/db-tables';
import { E2eeRow } from '@/e2ee/relay/e2ee-record-container';
import { parseE2eeFamilyWave } from '@/e2ee/relay/e2ee-record-event';
import { E2EE_MODERATION_TABLES } from '@/e2ee/relay/e2ee-record-tables';
import { e2eeBackupStreamOwner } from '@/e2ee/relay/e2ee-record-writers';
import {
  applyE2eeRules,
  E2eeRebuildProblem,
  E2eeRebuiltStream,
  rebuildE2eeStream
} from '@/e2ee/relay/e2ee-rebuild';
import {
  compareE2eeTables,
  E2eeRebuildDb,
  E2eeTableComparison
} from '@/e2ee/relay/e2ee-rebuild.db';

/** The reads the per-stream check needs from MySQL. */
export type E2eeStreamVerifyDb = Pick<
  E2eeRebuildDb,
  'rowsWhere' | 'headsPage' | 'backupProfiles'
>;
import type { E2eeStreamRebuildSource } from '@/e2ee/relay/e2ee-rebuild-run';
import { E2eeStreamHead } from '@/e2ee/relay/e2ee-stream-store';
import { ProviderKey } from '@/signed-records/sealed-crypto';

const REPORTED_FAILURES = 50;

/** One stream's tables, as MySQL holds them and as its records rebuild. */
interface ScopedTables {
  readonly table: string;
  readonly mysql: Map<string, E2eeRow>;
  readonly rebuilt: Map<string, E2eeRow>;
}

export interface E2eeStreamFailure {
  readonly wave: string;
  readonly problems: readonly E2eeRebuildProblem[];
  readonly head: { readonly mysql: number; readonly relays: number | null };
  readonly tables: readonly E2eeTableComparison[];
}

export interface E2eeStreamVerifyReport {
  readonly checked: number;
  readonly failed: number;
  readonly failures: readonly E2eeStreamFailure[];
  /** Pass as `after` to continue; null when every stream was checked. */
  readonly next: string | null;
  readonly ok: boolean;
}

function pick(
  rows: Map<string, E2eeRow>,
  keep: (row: E2eeRow) => boolean
): Map<string, E2eeRow> {
  return new Map(Array.from(rows.entries()).filter(([, row]) => keep(row)));
}

function ids(rows: Map<string, E2eeRow>, column: string): string[] {
  return Array.from(
    new Set(Array.from(rows.values()).map((r) => String(r[column])))
  );
}

async function groupScope(
  db: E2eeStreamVerifyDb,
  stream: E2eeRebuiltStream,
  group: string
): Promise<ScopedTables[]> {
  const tables = [
    E2EE_GROUPS_TABLE,
    E2EE_GROUP_EPOCHS_TABLE,
    E2EE_GROUP_ROSTER_TABLE,
    E2EE_LOG_TABLE
  ];
  const out: ScopedTables[] = [];
  for (const table of tables) {
    out.push({
      table,
      mysql: await db.rowsWhere(table, { group_handle: group }),
      rebuilt: stream.tables.get(table)!
    });
  }
  // A revocation's roster rows live in the device's inbox stream.
  const roster = out.find((item) => item.table === E2EE_GROUP_ROSTER_TABLE)!;
  for (const [key, row] of Array.from(roster.mysql.entries())) {
    if (row.removal_kind !== 'revoke') continue;
    roster.mysql.delete(key);
    roster.rebuilt.delete(key);
  }
  return out;
}

async function inboxScope(
  db: E2eeStreamVerifyDb,
  stream: E2eeRebuiltStream,
  device: string
): Promise<ScopedTables[]> {
  const deliveries = await db.rowsWhere(E2EE_WELCOME_DELIVERIES_TABLE, {
    device_key: device
  });
  const rebuiltDeliveries = stream.tables.get(E2EE_WELCOME_DELIVERIES_TABLE)!;
  const rebuiltWelcomeIds = new Set(ids(rebuiltDeliveries, 'welcome_id'));
  return [
    {
      table: E2EE_WELCOME_DELIVERIES_TABLE,
      mysql: deliveries,
      rebuilt: rebuiltDeliveries
    },
    {
      table: E2EE_WELCOMES_TABLE,
      mysql: await db.rowsWhere(E2EE_WELCOMES_TABLE, {
        id: ids(deliveries, 'welcome_id')
      }),
      rebuilt: pick(stream.tables.get(E2EE_WELCOMES_TABLE)!, (row) =>
        rebuiltWelcomeIds.has(String(row.id))
      )
    },
    {
      table: E2EE_GROUP_ROSTER_TABLE,
      mysql: await db.rowsWhere(E2EE_GROUP_ROSTER_TABLE, {
        device_key: device,
        removal_kind: 'revoke'
      }),
      rebuilt: stream.tables.get(E2EE_GROUP_ROSTER_TABLE)!
    }
  ];
}

async function deviceScope(
  db: E2eeStreamVerifyDb,
  stream: E2eeRebuiltStream,
  device: string
): Promise<ScopedTables[]> {
  return [
    {
      table: E2EE_DEVICES_TABLE,
      mysql: await db.rowsWhere(E2EE_DEVICES_TABLE, { device_key: device }),
      rebuilt: stream.tables.get(E2EE_DEVICES_TABLE)!
    },
    {
      table: E2EE_KEY_PACKAGES_TABLE,
      mysql: await db.rowsWhere(E2EE_KEY_PACKAGES_TABLE, {
        device_key: device,
        last_resort: true
      }),
      rebuilt: stream.tables.get(E2EE_KEY_PACKAGES_TABLE)!
    }
  ];
}

async function blobScope(
  db: E2eeStreamVerifyDb,
  stream: E2eeRebuiltStream,
  blob: string
): Promise<ScopedTables[]> {
  const out: ScopedTables[] = [];
  for (const table of [E2EE_BLOBS_TABLE, E2EE_BLOB_CHUNKS_TABLE]) {
    out.push({
      table,
      mysql: await db.rowsWhere(table, { blob_id: blob }),
      rebuilt: stream.tables.get(table)!
    });
  }
  return out;
}

async function backupScope(
  db: E2eeStreamVerifyDb,
  stream: E2eeRebuiltStream,
  profileId: string | null
): Promise<ScopedTables[]> {
  const where = { profile_id: profileId ?? '' };
  const chunks = profileId
    ? await db.rowsWhere(E2EE_BACKUP_CHUNKS_TABLE, where)
    : new Map<string, E2eeRow>();
  return [
    {
      table: E2EE_BACKUPS_TABLE,
      mysql: profileId
        ? await db.rowsWhere(E2EE_BACKUPS_TABLE, where)
        : new Map(),
      rebuilt: stream.tables.get(E2EE_BACKUPS_TABLE)!
    },
    {
      table: E2EE_BACKUP_CHUNKS_TABLE,
      mysql: chunks,
      rebuilt: stream.tables.get(E2EE_BACKUP_CHUNKS_TABLE)!
    },
    {
      table: E2EE_CIPHERTEXT_OBJECTS_TABLE,
      mysql: await db.rowsWhere(E2EE_CIPHERTEXT_OBJECTS_TABLE, {
        object_key: ids(chunks, 'object_key')
      }),
      rebuilt: stream.tables.get(E2EE_CIPHERTEXT_OBJECTS_TABLE)!
    }
  ];
}

/** The moderators' inbox holds every recorded report row. */
async function moderationScope(
  db: E2eeStreamVerifyDb,
  stream: E2eeRebuiltStream
): Promise<ScopedTables[]> {
  const out: ScopedTables[] = [];
  for (const table of E2EE_MODERATION_TABLES) {
    out.push({
      table,
      mysql: await db.rowsWhere(table, {}),
      rebuilt: stream.tables.get(table)!
    });
  }
  return out;
}

/**
 * The side-by-side check one stream at a time: for each stream MySQL has a
 * head for, rebuild that stream alone from the relays and compare its rows
 * and its head with MySQL's. Memory stays at one stream, so it runs at
 * production size; `after` and `limit` let an operator run it in slices.
 */
export async function verifyE2eeStreams(input: {
  readonly source: E2eeStreamRebuildSource;
  readonly db: E2eeStreamVerifyDb;
  readonly ordererDeviceKey: string;
  readonly now: number;
  readonly moderationKeys?: readonly ProviderKey[];
  readonly after?: string;
  readonly limit: number;
}): Promise<E2eeStreamVerifyReport> {
  const heads = await input.db.headsPage(input.after ?? '', input.limit);
  const backupOwners = new Map<string, string>();
  if (heads.some((head) => head.wave.startsWith('bk/'))) {
    for (const profileId of await input.db.backupProfiles()) {
      backupOwners.set(e2eeBackupStreamOwner(profileId), profileId);
    }
  }
  const failures: E2eeStreamFailure[] = [];
  let failed = 0;
  for (const head of heads) {
    const failure = await verifyStream(input, head, backupOwners);
    if (failure) {
      failed++;
      if (failures.length < REPORTED_FAILURES) failures.push(failure);
    }
  }
  const last = heads[heads.length - 1];
  return {
    checked: heads.length,
    failed,
    failures,
    next: heads.length === input.limit && last ? last.wave : null,
    ok: failed === 0
  };
}

async function verifyStream(
  input: {
    readonly source: E2eeStreamRebuildSource;
    readonly db: E2eeStreamVerifyDb;
    readonly ordererDeviceKey: string;
    readonly now: number;
    readonly moderationKeys?: readonly ProviderKey[];
  },
  head: E2eeStreamHead,
  backupOwners: ReadonlyMap<string, string>
): Promise<E2eeStreamFailure | null> {
  const parsed = parseE2eeFamilyWave(head.wave);
  if (!parsed) {
    return {
      wave: head.wave,
      problems: [{ wave: head.wave, reason: 'not a record stream' }],
      head: { mysql: head.pos, relays: null },
      tables: []
    };
  }
  const revokedDevices = new Set<string>();
  if (parsed.family === 'dv') {
    const [device] = Array.from(
      (
        await input.db.rowsWhere(E2EE_DEVICES_TABLE, {
          device_key: parsed.owner
        })
      ).values()
    );
    if (device && device.revoked_at !== null) revokedDevices.add(parsed.owner);
  }
  const stream = await rebuildE2eeStream(input.source, head.wave, {
    ordererDeviceKey: input.ordererDeviceKey,
    now: input.now,
    moderationKeys: input.moderationKeys,
    revokedDevices
  });
  const scoped = await scopeOf(input.db, stream, parsed, backupOwners);
  applyE2eeRules(
    new Map(scoped.map((item) => [item.table, item.mysql])),
    input.now,
    revokedDevices
  );
  const tables = scoped
    .map((item) => compareE2eeTables(item.table, item.rebuilt, item.mysql))
    .filter((t) => t.missing + t.extra + t.changed > 0);
  // Records whose content expired on the relays may be the newest ones.
  const headMatches =
    (stream.head?.pos === head.pos && stream.head?.hash === head.hash) ||
    (stream.expired > 0 &&
      (stream.head?.pos ?? 0) + stream.expired >= head.pos);
  if (!tables.length && headMatches && !stream.problems.length) return null;
  return {
    wave: head.wave,
    problems: stream.problems,
    head: { mysql: head.pos, relays: stream.head?.pos ?? null },
    tables
  };
}

function scopeOf(
  db: E2eeStreamVerifyDb,
  stream: E2eeRebuiltStream,
  parsed: { readonly family: string; readonly owner: string },
  backupOwners: ReadonlyMap<string, string>
): Promise<ScopedTables[]> {
  switch (parsed.family) {
    case 'cv':
      return groupScope(db, stream, parsed.owner);
    case 'dv':
      return inboxScope(db, stream, parsed.owner);
    case 'dr':
      return deviceScope(db, stream, parsed.owner);
    case 'bl':
      return blobScope(db, stream, parsed.owner);
    case 'bk':
      return backupScope(db, stream, backupOwners.get(parsed.owner) ?? null);
    case 'md':
      return moderationScope(db, stream);
    default:
      return Promise.resolve([]);
  }
}
