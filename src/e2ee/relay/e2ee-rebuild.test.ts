import {
  CONTENT_MODERATION_ITEMS_TABLE,
  CONTENT_MODERATION_REPORTS_TABLE,
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
  E2EE_REPORT_ACCESS_LOG_TABLE,
  E2EE_REPORTS_TABLE,
  E2EE_WELCOME_DELIVERIES_TABLE,
  E2EE_WELCOMES_TABLE
} from '@/constants/db-tables';
import { E2EE_MODERATION_INBOX } from '@/e2ee/relay/e2ee-moderation-seal';
import { E2eeRow, E2eeRowValue } from '@/e2ee/relay/e2ee-record-container';
import {
  E2EE_RECORD_TABLES,
  e2eeRecordKeyString,
  e2eeRecordTable
} from '@/e2ee/relay/e2ee-record-tables';
import {
  E2EE_WINDOWS_PER_RECORD,
  E2eeRecordWriters
} from '@/e2ee/relay/e2ee-record-writers';
import { rebuildE2eeState, rebuildE2eeStream } from '@/e2ee/relay/e2ee-rebuild';
import { compareE2eeTables } from '@/e2ee/relay/e2ee-rebuild.db';
import { relayE2eeRebuildSource } from '@/e2ee/relay/e2ee-rebuild-run';
import {
  backfillE2eeRecords,
  E2EE_BACKFILL_FAMILIES,
  E2eeBackfillDb,
  E2eeBackfillDeps,
  E2eeBackfillFamily,
  E2eeBackfillReport
} from '@/e2ee/relay/e2ee-relay-backfill';
import { E2eeRelaySettings } from '@/e2ee/relay/e2ee-relay-config';
import {
  E2eeStreamVerifyDb,
  verifyE2eeStreams
} from '@/e2ee/relay/e2ee-stream-verify';
import { E2eeRelayPool } from '@/e2ee/relay/e2ee-relay-pool';
import {
  E2eeRecordBatch,
  E2eeStreamPublisher,
  relayHeadAnchorSource
} from '@/e2ee/relay/e2ee-stream-publisher';
import { MockCrpRelay } from '@/tests/fixtures/e2ee-mock-crp-relay.fixture';
import {
  e2eeTestModerationKey,
  e2eeTestRelayIdentity,
  InMemoryE2eeStreamStore,
  settledRun
} from '@/tests/fixtures/e2ee-stream-store.fixture';
import { ConnectionWrapper } from '@/sql-executor';

const NET = '6529-interim-test';
const ORDERER = e2eeTestRelayIdentity(7, `0x${'aa'.repeat(20)}`);
const READER = e2eeTestRelayIdentity(9, `0x${'bb'.repeat(20)}`);
const MODERATION = e2eeTestModerationKey(0x31);
const INBOX = `md/${E2EE_MODERATION_INBOX}`;
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_795_000_000_000;
const T0 = NOW - DAY;

const hex = (byte: string, bytes = 32) => `0x${byte.repeat(bytes)}`;
const G = hex('01');
const G_OLD = hex('02');
const A = hex('0a');
const B = hex('0b');
const C = hex('0c');
const BLOB = hex('b1', 16);

/** The delivery service's tables in memory, read as the writers read them. */
class FakeTables {
  readonly tables = new Map<string, Map<string, E2eeRow>>(
    Object.keys(E2EE_RECORD_TABLES).map((name) => [name, new Map()])
  );

  put(table: string, row: Record<string, E2eeRowValue>) {
    const target = e2eeRecordTable(table);
    const full: Record<string, E2eeRowValue> = {};
    for (const column of Object.keys(target.columns)) {
      full[column] = row[column] ?? null;
    }
    this.tables.get(table)!.set(e2eeRecordKeyString(target, full), full);
  }

  del(table: string, match: Record<string, E2eeRowValue>) {
    const rows = this.tables.get(table)!;
    for (const [key, row] of Array.from(rows.entries())) {
      if (Object.entries(match).every(([c, v]) => row[c] === v)) {
        rows.delete(key);
      }
    }
  }

  update(
    table: string,
    match: Record<string, E2eeRowValue>,
    change: Record<string, E2eeRowValue>
  ) {
    const rows = this.tables.get(table)!;
    for (const [key, row] of Array.from(rows.entries())) {
      if (Object.entries(match).every(([c, v]) => row[c] === v)) {
        rows.set(key, { ...row, ...change });
      }
    }
  }

  async rows(
    table: string,
    where: Readonly<Record<string, E2eeRowValue | readonly E2eeRowValue[]>>,
    _connection: unknown,
    orderBy?: string
  ): Promise<E2eeRow[]> {
    const rows = Array.from(this.tables.get(table)!.values()).filter((row) =>
      Object.entries(where).every(([column, value]) =>
        Array.isArray(value)
          ? value.includes(row[column])
          : row[column] === value
      )
    );
    if (orderBy) {
      rows.sort((a, b) => (Number(a[orderBy]) < Number(b[orderBy]) ? -1 : 1));
    }
    return rows;
  }
}

function device(key: string, profile: string, at: number) {
  return {
    device_key: key,
    profile_id: profile,
    wallet: `0x${key.slice(2, 42)}`,
    ciphersuite: 78,
    grant_version: 2,
    ciphersuites: '78',
    issued_at_seconds: Math.floor(at / 1000),
    expires_at_seconds: Math.floor(at / 1000) + 180 * 86400,
    origin: 'test',
    grant_id: hex('99'),
    wallet_signature: '0xsig',
    verified_via: 'eip712',
    label: `Device ${profile}`,
    platform: 'web',
    created_at: at,
    updated_at: at,
    revoked_at: null,
    revoker_device_key: null,
    revocation_signed_at_seconds: null,
    revocation_signature: null,
    grant_message: null,
    notice_pending: false
  };
}

function logItem(
  group: string,
  seq: number,
  input: Record<string, E2eeRowValue>
) {
  return {
    group_handle: group,
    seq,
    item_type: 'message',
    epoch: 1,
    kind: null,
    commit_epoch: null,
    data: Buffer.alloc(512, seq),
    padded_len: 512,
    entry_hash: null,
    epoch_commitment: null,
    next_commit_key: null,
    signature: null,
    roster_add: null,
    roster_remove: null,
    epoch_fp: '0xfp',
    sender_device_key: A,
    sender_profile_id: 'pa',
    created_at: T0 + seq,
    ...input
  };
}

function dropReport(id: string, input: Record<string, E2eeRowValue>) {
  return {
    id,
    item_id: null,
    drop_id: 'drop-1',
    reporter_profile_id: 'pb',
    author_profile_id: 'pa',
    reason: 'SPAM',
    notes: 'the reporter notes',
    content_snapshot: '{"parts": [{"content": "reported words"}]}',
    status: 'OPEN',
    ai_recommendation: null,
    ai_category: null,
    ai_confidence: null,
    ai_rationale: null,
    ai_evidence: null,
    ai_policy_version: null,
    ai_assessed_at: null,
    created_at: T0 + 30,
    resolved_by_profile_id: null,
    resolution_reason: null,
    resolved_at: null,
    ...input
  };
}

function messageReport(id: string, createdAt: number) {
  return {
    id,
    group_handle: G,
    epoch: 1,
    body: Buffer.from(`reported message ${id}`),
    signature: '0xsig',
    sender_device_key: A,
    sender_profile_id: 'pa',
    reporter_device_key: B,
    reporter_profile_id: 'pb',
    reason: 'harassment',
    notes: null,
    verified: true,
    created_at: createdAt,
    on_hold: false
  };
}

async function scenario() {
  const relay = new MockCrpRelay({
    url: 'wss://relay.test',
    net: NET,
    head: 9000,
    roles: {
      [ORDERER.grant.wallet]: ['orderer'],
      [READER.grant.wallet]: ['site-reader']
    }
  });
  const settings: E2eeRelaySettings = {
    mode: 'mirror',
    urls: [relay.options.url],
    net: NET,
    quorum: 1,
    orderer: ORDERER,
    ordererPublicKey: ORDERER.deviceKey,
    siteReader: READER,
    moderation: MODERATION.recipient,
    moderationKeys: []
  };
  const pool = new E2eeRelayPool({
    urls: settings.urls,
    net: NET,
    identity: ORDERER,
    open: () => relay.connect()
  });
  const store = new InMemoryE2eeStreamStore();
  let clock = NOW;
  const publisher = new E2eeStreamPublisher({
    settings: () => settings,
    store,
    pool: () => pool,
    anchors: relayHeadAnchorSource(() => pool),
    now: () => clock++
  });
  const db = new FakeTables();
  const writers = new E2eeRecordWriters(db);
  /** While false, writes change the tables only (records were off). */
  const recording = { on: true };
  const write = (
    change: () => void,
    record: (
      batch: E2eeRecordBatch,
      connection: ConnectionWrapper<unknown>
    ) => Promise<void>
  ) =>
    settledRun(publisher, store, async (connection, batch) => {
      change();
      if (recording.on) await record(batch!, connection);
    });
  return { relay, settings, store, db, writers, write, publisher, recording };
}

async function runScenario(recorded = true) {
  const s = await scenario();
  s.recording.on = recorded;
  const { db, writers, write } = s;
  // Devices A, B and C.
  for (const [key, profile] of [
    [A, 'pa'],
    [B, 'pb'],
    [C, 'pc']
  ]) {
    await write(
      () => db.put(E2EE_DEVICES_TABLE, device(key, profile, T0)),
      (batch, c) => writers.deviceChanged(batch, c, key)
    );
  }
  // A renames its device.
  await write(
    () =>
      db.update(
        E2EE_DEVICES_TABLE,
        { device_key: A },
        { label: 'Laptop', updated_at: T0 + 5 }
      ),
    (batch, c) => writers.deviceChanged(batch, c, A)
  );
  // A's last-resort KeyPackage, then its replacement.
  for (const id of [1, 2]) {
    await write(
      () => {
        db.del(E2EE_KEY_PACKAGES_TABLE, {
          device_key: A,
          ciphersuite: 78,
          last_resort: true
        });
        db.put(E2EE_KEY_PACKAGES_TABLE, {
          id,
          device_key: A,
          data: Buffer.from(`kp-${id}`),
          last_resort: true,
          ciphersuite: 78,
          expires_at_seconds: Math.floor(NOW / 1000) + 86400,
          created_at: T0 + id
        });
      },
      (batch, c) =>
        writers.lastResortChanged(batch, c, { deviceKey: A, ciphersuite: 78 })
    );
  }
  // A creates G.
  await write(
    () => {
      db.put(E2EE_GROUPS_TABLE, {
        group_handle: G,
        epoch: 0,
        commit_key: hex('c0'),
        last_seq: 0,
        created_by_profile_id: 'pa',
        created_at: T0,
        updated_at: T0
      });
      db.put(E2EE_GROUP_EPOCHS_TABLE, {
        group_handle: G,
        epoch: 0,
        commit_key: hex('c0'),
        created_at: T0
      });
      db.put(E2EE_GROUP_ROSTER_TABLE, {
        id: 1,
        group_handle: G,
        device_key: A,
        profile_id: 'pa',
        joined_epoch: 0,
        added_at: T0
      });
    },
    (batch, c) => writers.groupCreated(batch, c, G)
  );
  // A commits B in (seq 1) with a Welcome for B.
  await write(
    () => {
      db.put(
        E2EE_LOG_TABLE,
        logItem(G, 1, {
          item_type: 'entry',
          epoch: 0,
          kind: 1,
          commit_epoch: 0,
          data: Buffer.alloc(2048, 1),
          padded_len: 2048,
          entry_hash: hex('e1'),
          epoch_commitment: hex('ec'),
          next_commit_key: hex('c1'),
          signature: '0xs',
          roster_add: JSON.stringify([B]),
          roster_remove: '[]',
          epoch_fp: null
        })
      );
      db.put(E2EE_GROUPS_TABLE, {
        group_handle: G,
        epoch: 1,
        commit_key: hex('c1'),
        last_seq: 1,
        created_by_profile_id: 'pa',
        created_at: T0,
        updated_at: T0 + 1
      });
      db.put(E2EE_GROUP_EPOCHS_TABLE, {
        group_handle: G,
        epoch: 1,
        commit_key: hex('c1'),
        created_at: T0 + 1
      });
      db.put(E2EE_GROUP_ROSTER_TABLE, {
        id: 2,
        group_handle: G,
        device_key: B,
        profile_id: 'pb',
        joined_epoch: 1,
        added_at: T0 + 1
      });
      db.put(E2EE_WELCOMES_TABLE, {
        id: hex('w1', 16),
        group_handle: G,
        epoch: 1,
        data: Buffer.from('welcome-1'),
        ratchet_tree: Buffer.from('tree'),
        added_by_profile_id: 'pa',
        added_by_device_key: A,
        created_at: T0 + 1
      });
      db.put(E2EE_WELCOME_DELIVERIES_TABLE, {
        welcome_id: hex('w1', 16),
        device_key: B,
        profile_id: 'pb',
        created_at: T0 + 1
      });
    },
    async (batch, c) => {
      await writers.itemSequenced(batch, c, {
        group: G,
        seq: 1,
        changedDevices: [B]
      });
      await writers.welcomeStored(batch, c, hex('w1', 16));
    }
  );
  // B sends a large message (seq 2), then takes its Welcome.
  await write(
    () => {
      db.put(
        E2EE_LOG_TABLE,
        logItem(G, 2, {
          sender_device_key: B,
          sender_profile_id: 'pb',
          data: Buffer.alloc(65536, 2),
          padded_len: 65536
        })
      );
      db.update(
        E2EE_GROUPS_TABLE,
        { group_handle: G },
        { last_seq: 2, updated_at: T0 + 2 }
      );
    },
    (batch, c) =>
      writers.itemSequenced(batch, c, { group: G, seq: 2, changedDevices: [] })
  );
  await write(
    () => {
      db.del(E2EE_WELCOME_DELIVERIES_TABLE, {
        welcome_id: hex('w1', 16),
        device_key: B
      });
      db.del(E2EE_WELCOMES_TABLE, { id: hex('w1', 16) });
    },
    (batch, c) =>
      writers.welcomeAcked(batch, c, { welcomeId: hex('w1', 16), deviceKey: B })
  );
  // A commits C in (seq 3) with a Welcome for C, then C is revoked.
  await write(
    () => {
      db.put(
        E2EE_LOG_TABLE,
        logItem(G, 3, {
          item_type: 'entry',
          kind: 1,
          commit_epoch: 1,
          data: Buffer.alloc(2048, 3),
          padded_len: 2048,
          roster_add: JSON.stringify([C]),
          roster_remove: '[]'
        })
      );
      db.put(E2EE_GROUPS_TABLE, {
        group_handle: G,
        epoch: 2,
        commit_key: hex('c2'),
        last_seq: 3,
        created_by_profile_id: 'pa',
        created_at: T0,
        updated_at: T0 + 3
      });
      db.put(E2EE_GROUP_EPOCHS_TABLE, {
        group_handle: G,
        epoch: 2,
        commit_key: hex('c2'),
        created_at: T0 + 3
      });
      db.put(E2EE_GROUP_ROSTER_TABLE, {
        id: 3,
        group_handle: G,
        device_key: C,
        profile_id: 'pc',
        joined_epoch: 2,
        added_at: T0 + 3
      });
      db.put(E2EE_WELCOMES_TABLE, {
        id: hex('w2', 16),
        group_handle: G,
        epoch: 2,
        data: Buffer.from('welcome-2'),
        ratchet_tree: null,
        added_by_profile_id: 'pa',
        added_by_device_key: A,
        created_at: T0 + 3
      });
      db.put(E2EE_WELCOME_DELIVERIES_TABLE, {
        welcome_id: hex('w2', 16),
        device_key: C,
        profile_id: 'pc',
        created_at: T0 + 3
      });
    },
    async (batch, c) => {
      await writers.itemSequenced(batch, c, {
        group: G,
        seq: 3,
        changedDevices: [C]
      });
      await writers.welcomeStored(batch, c, hex('w2', 16));
    }
  );
  await write(
    () => {
      db.update(
        E2EE_DEVICES_TABLE,
        { device_key: C },
        {
          revoked_at: T0 + 4,
          revoker_device_key: C,
          revocation_signed_at_seconds: 1,
          revocation_signature: '0xrev'
        }
      );
      db.update(
        E2EE_GROUP_ROSTER_TABLE,
        { device_key: C },
        { removed_epoch: 2, removed_at: T0 + 4, removal_kind: 'revoke' }
      );
      db.del(E2EE_WELCOME_DELIVERIES_TABLE, { device_key: C });
      db.del(E2EE_WELCOMES_TABLE, { id: hex('w2', 16) });
    },
    (batch, c) => writers.deviceRevoked(batch, c, { deviceKey: C, groups: [G] })
  );
  // A repairs the roster: B is dropped at epoch 2.
  await write(
    () =>
      db.update(
        E2EE_GROUP_ROSTER_TABLE,
        { device_key: B },
        { removed_epoch: 2, removed_at: T0 + 5, removal_kind: 'repair' }
      ),
    (batch, c) => writers.rosterChanged(batch, c, { group: G, devices: [B] })
  );
  // An old group whose only message is past retention (MySQL pruned it).
  await write(
    () => {
      db.put(E2EE_GROUPS_TABLE, {
        group_handle: G_OLD,
        epoch: 0,
        commit_key: hex('d0'),
        last_seq: 1,
        created_by_profile_id: 'pa',
        created_at: NOW - 200 * DAY,
        updated_at: NOW - 100 * DAY
      });
      db.put(
        E2EE_LOG_TABLE,
        logItem(G_OLD, 1, { created_at: NOW - 100 * DAY })
      );
    },
    async (batch, c) => {
      await writers.groupCreated(batch, c, G_OLD);
      await writers.itemSequenced(batch, c, {
        group: G_OLD,
        seq: 1,
        changedDevices: []
      });
    }
  );
  db.del(E2EE_LOG_TABLE, { group_handle: G_OLD, seq: 1 });
  // An attachment held in S3 (MySQL keeps only the sizes).
  db.put(E2EE_BLOBS_TABLE, {
    blob_id: BLOB,
    group_handle: G,
    uploader_device_key: A,
    uploader_profile_id: 'pa',
    size: 3000,
    chunk_count: 2,
    complete: false,
    created_at: T0 + 6,
    completed_at: null,
    storage: 's3',
    storage_location: 's3://bucket/prefix'
  });
  for (const [index, size] of [
    [0, 2000],
    [1, 1000]
  ]) {
    await write(
      () =>
        db.put(E2EE_BLOB_CHUNKS_TABLE, {
          blob_id: BLOB,
          chunk_index: index,
          data: Buffer.alloc(0),
          size,
          created_at: T0 + 7
        }),
      (batch, c) =>
        writers.blobChunkStored(batch, c, {
          blobId: BLOB,
          index,
          data: Buffer.alloc(size, index + 1)
        })
    );
  }
  await write(
    () =>
      db.update(
        E2EE_BLOBS_TABLE,
        { blob_id: BLOB },
        { complete: true, completed_at: T0 + 8 }
      ),
    (batch, c) => writers.blobCompleted(batch, c, BLOB)
  );
  // A's backups: a generation, two chunks, activation, compaction.
  const gen = hex('9e', 16);
  await write(
    () =>
      db.put(E2EE_BACKUPS_TABLE, {
        backup_id: gen,
        profile_id: 'pa',
        envelope: Buffer.from('env'),
        active: false,
        next_seq: 1,
        chunk_count: 0,
        size: 0,
        created_by_device_key: A,
        created_at: T0 + 9,
        updated_at: T0 + 9,
        activated_at: null
      }),
    (batch, c) => writers.backupsChanged(batch, c, { profileId: 'pa' })
  );
  for (const seq of [1, 2]) {
    const data = Buffer.alloc(4096, seq);
    await write(
      () => {
        db.put(E2EE_BACKUP_CHUNKS_TABLE, {
          backup_id: gen,
          seq,
          profile_id: 'pa',
          size: 4096,
          object_key: `backup/${gen}/${seq}`,
          uploader_device_key: A,
          created_at: T0 + 10 + seq
        });
        db.put(E2EE_CIPHERTEXT_OBJECTS_TABLE, {
          object_key: `backup/${gen}/${seq}`,
          data,
          created_at: T0 + 10 + seq
        });
        db.update(
          E2EE_BACKUPS_TABLE,
          { backup_id: gen },
          {
            next_seq: seq + 1,
            chunk_count: seq,
            size: 4096 * seq,
            updated_at: T0 + 10 + seq
          }
        );
      },
      (batch, c) =>
        writers.backupsChanged(batch, c, {
          profileId: 'pa',
          appended: { backupId: gen, seq, data }
        })
    );
  }
  await write(
    () =>
      db.update(
        E2EE_BACKUPS_TABLE,
        { backup_id: gen },
        { active: true, activated_at: T0 + 13, updated_at: T0 + 13 }
      ),
    (batch, c) => writers.backupsChanged(batch, c, { profileId: 'pa' })
  );
  await write(
    () => {
      db.del(E2EE_BACKUP_CHUNKS_TABLE, { backup_id: gen, seq: 1 });
      db.del(E2EE_CIPHERTEXT_OBJECTS_TABLE, { object_key: `backup/${gen}/1` });
      db.update(
        E2EE_BACKUPS_TABLE,
        { backup_id: gen },
        { chunk_count: 1, size: 4096, updated_at: T0 + 14 }
      );
    },
    (batch, c) =>
      writers.backupsChanged(batch, c, {
        profileId: 'pa',
        deletedChunks: [{ backupId: gen, seq: 1 }],
        deletedObjectKeys: [`backup/${gen}/1`]
      })
  );
  // Reports, recorded after each write as the report services do.
  const report =
    (table: string, where: Record<string, E2eeRowValue>) =>
    async (batch: E2eeRecordBatch, c: ConnectionWrapper<unknown>) => {
      await writers.moderationRowsChanged(batch, c, { table, where });
    };
  await write(
    () => db.put(CONTENT_MODERATION_REPORTS_TABLE, dropReport('r1', {})),
    report(CONTENT_MODERATION_REPORTS_TABLE, { id: 'r1' })
  );
  await write(
    () =>
      db.update(
        CONTENT_MODERATION_REPORTS_TABLE,
        { id: 'r1' },
        {
          ai_recommendation: 'REMOVE',
          ai_confidence: '0.9500',
          ai_rationale: 'spam',
          ai_evidence: '[{"quote": "reported words"}]',
          ai_assessed_at: T0 + 31
        }
      ),
    report(CONTENT_MODERATION_REPORTS_TABLE, { id: 'r1' })
  );
  await write(
    () =>
      db.update(
        CONTENT_MODERATION_REPORTS_TABLE,
        { drop_id: 'drop-1' },
        {
          status: 'RESOLVED_REMOVED',
          resolved_by_profile_id: 'pm',
          resolved_at: T0 + 32
        }
      ),
    report(CONTENT_MODERATION_REPORTS_TABLE, { drop_id: 'drop-1' })
  );
  // Moderation items: r1's report item, bound while r1 was open (the prune
  // marks it reviewed later, unrecorded), and an override a moderator gave.
  const item = (id: string, input: Record<string, E2eeRowValue>) => ({
    id,
    subject_type: 'DROP',
    subject_id: 'drop-1',
    author_profile_id: 'pa',
    actor_profile_id: 'pb',
    operation: 'REPORT',
    policy_family: 'WAVE_CONTENT',
    policy_version: 'v1',
    content_fingerprint: 'f'.repeat(64),
    scope: '{"report_id": "r1"}',
    review_status: 'NEEDS_REVIEW',
    override: null,
    permit_expires_at: null,
    permit_consumed_at: null,
    published_subject_id: 'drop-1',
    suppressed: false,
    created_at: T0 + 33,
    ...input
  });
  await write(
    () => {
      s.db.put(CONTENT_MODERATION_ITEMS_TABLE, item('a'.repeat(64), {}));
      s.db.update(
        CONTENT_MODERATION_REPORTS_TABLE,
        { id: 'r1' },
        { item_id: 'a'.repeat(64) }
      );
    },
    async (batch, c) => {
      await writers.moderationRowsChanged(batch, c, {
        table: CONTENT_MODERATION_REPORTS_TABLE,
        where: { id: 'r1' }
      });
      await writers.moderationRowsChanged(batch, c, {
        table: CONTENT_MODERATION_ITEMS_TABLE,
        where: { id: 'a'.repeat(64) }
      });
    }
  );
  s.db.update(
    CONTENT_MODERATION_ITEMS_TABLE,
    { id: 'a'.repeat(64) },
    { review_status: 'REVIEWED' }
  );
  await write(
    () =>
      s.db.put(
        CONTENT_MODERATION_ITEMS_TABLE,
        item('b'.repeat(64), {
          operation: 'CREATE',
          scope: '{}',
          review_status: 'REVIEWED',
          override: 'ALLOW',
          permit_expires_at: NOW + 7 * DAY
        })
      ),
    report(CONTENT_MODERATION_ITEMS_TABLE, { id: 'b'.repeat(64) })
  );
  // Resolved 100 days ago: MySQL's prune has since cleared its evidence.
  await write(
    () =>
      db.put(
        CONTENT_MODERATION_REPORTS_TABLE,
        dropReport('r2', {
          drop_id: 'drop-2',
          status: 'DISMISSED',
          created_at: NOW - 101 * DAY,
          resolved_at: NOW - 100 * DAY
        })
      ),
    report(CONTENT_MODERATION_REPORTS_TABLE, { id: 'r2' })
  );
  db.update(
    CONTENT_MODERATION_REPORTS_TABLE,
    { id: 'r2' },
    {
      content_snapshot: '{"evidence_expired": true}',
      notes: null,
      ai_rationale: null,
      ai_evidence: null
    }
  );
  // Message reports: one put on hold; an old one past retention (pruned);
  // an old one held.
  await write(
    () => db.put(E2EE_REPORTS_TABLE, messageReport('0xe1', T0 + 40)),
    report(E2EE_REPORTS_TABLE, { id: '0xe1' })
  );
  await write(
    () => db.update(E2EE_REPORTS_TABLE, { id: '0xe1' }, { on_hold: true }),
    report(E2EE_REPORTS_TABLE, { id: '0xe1' })
  );
  await write(
    () => db.put(E2EE_REPORTS_TABLE, messageReport('0xe2', NOW - 200 * DAY)),
    report(E2EE_REPORTS_TABLE, { id: '0xe2' })
  );
  db.del(E2EE_REPORTS_TABLE, { id: '0xe2' });
  await write(
    () =>
      db.put(E2EE_REPORTS_TABLE, {
        ...messageReport('0xe3', NOW - 200 * DAY),
        on_hold: true
      }),
    report(E2EE_REPORTS_TABLE, { id: '0xe3' })
  );
  for (const id of [1, 2]) {
    await write(
      () =>
        db.put(E2EE_REPORT_ACCESS_LOG_TABLE, {
          id,
          viewer_profile_id: 'pm',
          action: id === 1 ? 'list' : 'hold',
          report_ids: '0xe1',
          created_at: T0 + 40 + id
        }),
      report(E2EE_REPORT_ACCESS_LOG_TABLE, { id })
    );
  }
  return s;
}

function readerSource(relay: MockCrpRelay) {
  return relayE2eeRebuildSource(
    new E2eeRelayPool({
      urls: [relay.options.url],
      net: NET,
      identity: READER,
      open: () => relay.connect()
    })
  );
}

describe('rebuildE2eeState', () => {
  it('rebuilds every table row for row from the relays alone', async () => {
    const { relay, db, store } = await runScenario();
    expect(store.outboxRows).toEqual([]);
    const state = await rebuildE2eeState(readerSource(relay), {
      ordererDeviceKey: ORDERER.deviceKey,
      now: NOW,
      moderationKeys: MODERATION.keys
    });
    expect(state.problems).toEqual([]);
    for (const table of Object.keys(E2EE_RECORD_TABLES)) {
      const mysql =
        table === E2EE_KEY_PACKAGES_TABLE
          ? new Map(
              Array.from(db.tables.get(table)!.entries()).filter(
                ([, row]) => row.last_resort === true
              )
            )
          : db.tables.get(table)!;
      expect(
        compareE2eeTables(table, state.tables.get(table)!, mysql)
      ).toMatchObject({
        table,
        missing: 0,
        extra: 0,
        changed: 0
      });
    }
    expect(state.tables.get(E2EE_LOG_TABLE)!.size).toBe(3);
    expect(state.tables.get(E2EE_WELCOMES_TABLE)!.size).toBe(0);
    expect(state.tables.get(E2EE_KEY_PACKAGES_TABLE)!.size).toBe(1);
    // The bytes S3 held come back from the relays, stored in MySQL.
    const chunks = Array.from(
      state.tables.get(E2EE_BLOB_CHUNKS_TABLE)!.values()
    );
    expect(chunks.map((row) => (row.data as Buffer).length)).toEqual([
      2000, 1000
    ]);
    expect(
      Array.from(state.tables.get(E2EE_BLOBS_TABLE)!.values())[0]
    ).toMatchObject({
      storage: 'mysql',
      storage_location: null
    });
    // Activity: the latest item each device sent.
    expect(
      state.tables.get(E2EE_DEVICES_TABLE)!.get(JSON.stringify([B]))
    ).toMatchObject({
      last_seen_at: T0 + 2
    });
    for (const head of state.heads) {
      expect(store.head(head.wave)).toEqual(head);
    }
  });

  it('keeps an empty rebuild empty', async () => {
    const { relay } = await scenario();
    const state = await rebuildE2eeState(readerSource(relay), {
      ordererDeviceKey: ORDERER.deviceKey,
      now: NOW,
      moderationKeys: MODERATION.keys
    });
    expect(state.problems).toEqual([]);
    expect(state.heads).toEqual([]);
    for (const rows of Array.from(state.tables.values()))
      expect(rows.size).toBe(0);
  });

  it('reports a lost ciphertext still inside retention, and a gap', async () => {
    const { relay } = await runScenario();
    const item = relay.stored.find(
      (stored) =>
        stored.event.kind === 11 && JSON.parse(stored.event.body!).seq === 3
    )!;
    relay.dropPayload(JSON.parse(item.event.body!).data.h);
    const state = await rebuildE2eeState(readerSource(relay), {
      ordererDeviceKey: ORDERER.deviceKey,
      now: NOW,
      moderationKeys: MODERATION.keys
    });
    expect(state.problems).toContainEqual({
      wave: `cv/${G}`,
      reason: 'item 2 lost its ciphertext before retention'
    });
    const source = readerSource(relay);
    const withGap = await rebuildE2eeState(
      {
        events: async (families) =>
          (await source.events(families)).filter(
            (stored) => stored.event.id !== item.event.id
          ),
        payload: source.payload
      },
      {
        ordererDeviceKey: ORDERER.deviceKey,
        now: NOW,
        moderationKeys: MODERATION.keys
      }
    );
    expect(withGap.problems).toContainEqual({
      wave: `cv/${G}`,
      pos: 3,
      reason: 'gap in the stream'
    });
  });

  it('rebuilds the reports only with the moderation key; relays see no report', async () => {
    const { relay } = await runScenario();
    const reports = relay.stored.filter((item) => item.event.wave === INBOX);
    expect(reports.length).toBe(13);
    // Report rows go as SEALED records; a moderator's decision on an item
    // as a RECORD keyed by the item id. Both are sealed.
    expect(
      reports
        .filter((item) => item.event.kind === 9)
        .map((item) => item.event.refs)
    ).toEqual([
      ['moderation-item', 'a'.repeat(64)],
      ['moderation-item', 'b'.repeat(64)]
    ]);
    for (const item of reports) {
      expect([9, 10]).toContain(item.event.kind);
      expect(item.event.body).not.toContain('reported');
      expect(item.event.body).not.toContain('ALLOW');
    }
    const state = await rebuildE2eeState(readerSource(relay), {
      ordererDeviceKey: ORDERER.deviceKey,
      now: NOW
    });
    expect(state.problems).toHaveLength(13);
    expect(state.problems[0]).toMatchObject({
      wave: INBOX,
      reason:
        'sealed content: Sealed to svc:mod-test, a key this reader does not hold'
    });
    expect(state.tables.get(E2EE_REPORTS_TABLE)!.size).toBe(0);
    expect(state.tables.get(E2EE_LOG_TABLE)!.size).toBe(3);
  });

  it('accepts only the pinned orderer key', async () => {
    const { relay } = await runScenario();
    const state = await rebuildE2eeState(readerSource(relay), {
      ordererDeviceKey: READER.deviceKey,
      now: NOW
    });
    expect(state.stats.records).toBe(0);
    expect(state.problems.length).toBe(relay.stored.length);
    expect(state.problems[0].reason).toBe("not the orderer's record (author)");
  });
});

/** The backfill's reads and locks, over the tables in memory. */
function backfillDb(
  db: FakeTables,
  runner: InMemoryE2eeStreamStore
): E2eeBackfillDb {
  const all = (table: string) => Array.from(db.tables.get(table)!.values());
  const after = (keys: string[], cursor: string, limit: number) =>
    keys
      .filter((key) => key > cursor)
      .sort((a, b) => (a < b ? -1 : 1))
      .slice(0, limit);
  return {
    executeNativeQueriesInTransaction: (work) =>
      runner.executeNativeQueriesInTransaction(work),
    volume: async () => ({
      groups: all(E2EE_GROUPS_TABLE).length,
      entries: all(E2EE_LOG_TABLE).filter((row) => row.item_type === 'entry')
        .length,
      entryBytes: 0,
      messages: all(E2EE_LOG_TABLE).filter((row) => row.item_type === 'message')
        .length,
      messageBytes: 0,
      pendingWelcomes: all(E2EE_WELCOME_DELIVERIES_TABLE).length,
      welcomeBytes: 0,
      devices: all(E2EE_DEVICES_TABLE).length,
      lastResortKeyPackages: all(E2EE_KEY_PACKAGES_TABLE).length,
      completeBlobs: all(E2EE_BLOBS_TABLE).length,
      blobBytes: 0,
      backups: all(E2EE_BACKUPS_TABLE).length,
      backupChunks: all(E2EE_BACKUP_CHUNKS_TABLE).length,
      backupBytes: 0,
      reports: all(CONTENT_MODERATION_REPORTS_TABLE).length,
      messageReports: all(E2EE_REPORTS_TABLE).length,
      reportAccess: all(E2EE_REPORT_ACCESS_LOG_TABLE).length,
      moderationDecisions: all(CONTENT_MODERATION_ITEMS_TABLE).length
    }),
    reportKeys: async (cursor, limit) =>
      [
        ...all(E2EE_REPORT_ACCESS_LOG_TABLE).map((row) => ({
          key: `a:${String(row.id).padStart(20, '0')}`,
          table: E2EE_REPORT_ACCESS_LOG_TABLE,
          id: Number(row.id)
        })),
        ...all(E2EE_REPORTS_TABLE).map((row) => ({
          key: `e:${String(row.id)}`,
          table: E2EE_REPORTS_TABLE,
          id: String(row.id)
        })),
        ...all(CONTENT_MODERATION_ITEMS_TABLE).map((row) => ({
          key: `i:${String(row.id)}`,
          table: CONTENT_MODERATION_ITEMS_TABLE,
          id: String(row.id)
        })),
        ...all(CONTENT_MODERATION_REPORTS_TABLE).map((row) => ({
          key: `r:${String(row.id)}`,
          table: CONTENT_MODERATION_REPORTS_TABLE,
          id: String(row.id)
        }))
      ]
        .filter((key) => key.key > cursor)
        .sort((a, b) => (a.key < b.key ? -1 : 1))
        .slice(0, limit),
    groups: async (cursor, limit) =>
      after(
        all(E2EE_GROUPS_TABLE).map((row) => String(row.group_handle)),
        cursor,
        limit
      ),
    devices: async (cursor, limit) =>
      after(
        all(E2EE_DEVICES_TABLE).map((row) => String(row.device_key)),
        cursor,
        limit
      ),
    inboxes: async (cursor, limit) =>
      after(
        Array.from(
          new Set([
            ...all(E2EE_WELCOME_DELIVERIES_TABLE).map((row) =>
              String(row.device_key)
            ),
            ...all(E2EE_GROUP_ROSTER_TABLE)
              .filter((row) => row.removal_kind === 'revoke')
              .map((row) => String(row.device_key)),
            ...(await runner.listHeads('', 100_000))
              .filter((head) => head.wave.startsWith('dv/'))
              .map((head) => head.wave.slice(3))
          ])
        ),
        cursor,
        limit
      ),
    completeBlobs: async (cursor, limit) =>
      all(E2EE_BLOBS_TABLE)
        .filter((row) => row.complete === true && String(row.blob_id) > cursor)
        .slice(0, limit)
        .map((row) => ({
          blob_id: String(row.blob_id),
          chunk_count: Number(row.chunk_count),
          storage: String(row.storage),
          storage_location:
            row.storage_location === null ? null : String(row.storage_location)
        })),
    backupProfiles: async (cursor, limit) =>
      after(
        Array.from(
          new Set(all(E2EE_BACKUPS_TABLE).map((row) => String(row.profile_id)))
        ),
        cursor,
        limit
      ),
    itemSeqs: async (group, through) =>
      all(E2EE_LOG_TABLE)
        .filter(
          (row) => row.group_handle === group && Number(row.seq) <= through
        )
        .map((row) => Number(row.seq))
        .sort((a, b) => a - b),
    lockGroup: async (group) => {
      const row = all(E2EE_GROUPS_TABLE).find((g) => g.group_handle === group);
      return row ? Number(row.last_seq) : null;
    },
    lockDevice: async (device) =>
      all(E2EE_DEVICES_TABLE).some((row) => row.device_key === device)
        ? Array.from(
            new Set(
              all(E2EE_KEY_PACKAGES_TABLE)
                .filter(
                  (row) => row.device_key === device && row.last_resort === true
                )
                .map((row) => Number(row.ciphersuite))
            )
          )
        : null,
    lockBlob: async (blobId) =>
      all(E2EE_BLOBS_TABLE).some(
        (row) => row.blob_id === blobId && row.complete === true
      ),
    lockBackups: async (profileId) =>
      all(E2EE_BACKUP_CHUNKS_TABLE)
        .filter((row) => row.profile_id === profileId)
        .map((row) => ({
          backupId: String(row.backup_id),
          seq: Number(row.seq),
          objectKey: String(row.object_key)
        }))
  };
}

async function backfillAll(
  s: Awaited<ReturnType<typeof scenario>>,
  overrides: Partial<E2eeBackfillDeps> = {},
  families: readonly E2eeBackfillFamily[] = E2EE_BACKFILL_FAMILIES
): Promise<E2eeBackfillReport[]> {
  const deps: E2eeBackfillDeps = {
    db: backfillDb(s.db, s.store),
    writers: s.writers,
    run: (work) =>
      settledRun(s.publisher, s.store, (connection, batch) =>
        work(connection, batch!)
      ),
    // The attachment bytes, as S3 holds them in the scenario.
    blobChunk: async (_blob, index) =>
      Buffer.alloc(index === 0 ? 2000 : 1000, index + 1),
    backupObject: async (key) => {
      const row = Array.from(
        s.db.tables.get(E2EE_CIPHERTEXT_OBJECTS_TABLE)!.values()
      ).find((object) => object.object_key === key);
      return (row?.data as Buffer | undefined) ?? null;
    },
    now: () => NOW,
    ...overrides
  };
  const reports: E2eeBackfillReport[] = [];
  for (const family of families) {
    let after: string | undefined;
    do {
      const report = await backfillE2eeRecords(deps, {
        live: true,
        family,
        after,
        limit: 2
      });
      // The volume scans run in the dry run only.
      expect(report.volume).toBeNull();
      reports.push(report);
      after = report.next ?? undefined;
    } while (after !== undefined);
  }
  return reports;
}

function expectSameTables(
  db: FakeTables,
  state: Awaited<ReturnType<typeof rebuildE2eeState>>
) {
  expect(state.problems).toEqual([]);
  for (const table of Object.keys(E2EE_RECORD_TABLES)) {
    const mysql =
      table === E2EE_KEY_PACKAGES_TABLE
        ? new Map(
            Array.from(db.tables.get(table)!.entries()).filter(
              ([, row]) => row.last_resort === true
            )
          )
        : db.tables.get(table)!;
    expect(
      compareE2eeTables(table, state.tables.get(table)!, mysql)
    ).toMatchObject({ table, missing: 0, extra: 0, changed: 0 });
  }
}

function rebuildFrom(relay: MockCrpRelay) {
  return rebuildE2eeState(readerSource(relay), {
    ordererDeviceKey: ORDERER.deviceKey,
    now: NOW,
    moderationKeys: MODERATION.keys
  });
}

describe('backfillE2eeRecords', () => {
  it('measures only, by default', async () => {
    const s = await runScenario(false);
    const report = await backfillE2eeRecords(
      {
        db: backfillDb(s.db, s.store),
        writers: s.writers,
        run: () => Promise.reject(new Error('no writes in a dry run')),
        blobChunk: () => Promise.reject(new Error('no reads')),
        backupObject: () => Promise.reject(new Error('no reads')),
        now: () => NOW
      },
      { live: false, family: 'cv', limit: 10 }
    );
    expect(report).toMatchObject({
      live: false,
      examined: 0,
      copied: 0,
      volume: {
        groups: 2,
        entries: 2,
        messages: 1,
        devices: 3,
        completeBlobs: 1
      }
    });
    expect(s.relay.stored).toEqual([]);
  });

  it('skips an attachment whose stored bytes read back empty', async () => {
    const s = await runScenario(false);
    const reports = await backfillAll(
      s,
      { blobChunk: async () => Buffer.alloc(0) },
      ['bl']
    );
    expect(reports.flatMap((report) => report.skipped)).toHaveLength(1);
    expect(
      s.relay.stored.filter((item) => item.event.wave.startsWith('bl/'))
    ).toEqual([]);
  });

  it('copies state written before records existed, so a rebuild matches MySQL', async () => {
    const s = await runScenario(false);
    expect(s.relay.stored).toEqual([]);
    await backfillAll(s);
    expectSameTables(s.db, await rebuildFrom(s.relay));
  });

  it('is safe to run twice and over records the live path already wrote', async () => {
    const s = await runScenario(true);
    await backfillAll(s);
    await backfillAll(s);
    expectSameTables(s.db, await rebuildFrom(s.relay));
  });

  it('carries deletes and acks made while records were off', async () => {
    const s = await runScenario(true);
    s.recording.on = false;
    // While off: B's pending Welcome is acked, a backup chunk compacted
    // away, and A repairs the roster.
    const welcome = hex('4d', 16);
    s.db.put(E2EE_WELCOMES_TABLE, {
      id: welcome,
      group_handle: G,
      epoch: 2,
      data: Buffer.from('w4'),
      ratchet_tree: null,
      added_by_profile_id: 'pa',
      added_by_device_key: A,
      created_at: T0 + 30
    });
    s.db.put(E2EE_WELCOME_DELIVERIES_TABLE, {
      welcome_id: welcome,
      device_key: B,
      profile_id: 'pb',
      created_at: T0 + 30
    });
    s.recording.on = true;
    await s.write(
      () => undefined,
      (batch, c) => s.writers.welcomeStored(batch, c, welcome)
    );
    s.recording.on = false;
    s.db.del(E2EE_WELCOME_DELIVERIES_TABLE, { welcome_id: welcome });
    s.db.del(E2EE_WELCOMES_TABLE, { id: welcome });
    const gen = hex('9e', 16);
    s.db.del(E2EE_BACKUP_CHUNKS_TABLE, { backup_id: gen, seq: 2 });
    s.db.del(E2EE_CIPHERTEXT_OBJECTS_TABLE, { object_key: `backup/${gen}/2` });
    s.db.update(
      E2EE_BACKUPS_TABLE,
      { backup_id: gen },
      { chunk_count: 0, size: 0, updated_at: T0 + 31 }
    );
    s.db.update(
      E2EE_GROUP_ROSTER_TABLE,
      { device_key: A },
      { removed_epoch: 2, removed_at: T0 + 32, removal_kind: 'repair' }
    );
    // Without the snapshot copies the relays still say otherwise.
    expect(
      (await rebuildFrom(s.relay)).tables.get(E2EE_WELCOME_DELIVERIES_TABLE)!
        .size
    ).toBe(1);
    s.recording.on = true;
    await backfillAll(s);
    expectSameTables(s.db, await rebuildFrom(s.relay));
  });

  it('lets a later write win over the copy', async () => {
    const s = await runScenario(false);
    const welcome = hex('3c', 16);
    s.db.put(E2EE_WELCOMES_TABLE, {
      id: welcome,
      group_handle: G,
      epoch: 2,
      data: Buffer.from('w3'),
      ratchet_tree: null,
      added_by_profile_id: 'pa',
      added_by_device_key: A,
      created_at: T0 + 20
    });
    s.db.put(E2EE_WELCOME_DELIVERIES_TABLE, {
      welcome_id: welcome,
      device_key: B,
      profile_id: 'pb',
      created_at: T0 + 20
    });
    await backfillAll(s);
    s.recording.on = true;
    await s.write(
      () => {
        s.db.del(E2EE_WELCOME_DELIVERIES_TABLE, { welcome_id: welcome });
        s.db.del(E2EE_WELCOMES_TABLE, { id: welcome });
        s.db.update(
          E2EE_DEVICES_TABLE,
          { device_key: A },
          { label: 'Phone', updated_at: T0 + 21 }
        );
      },
      async (batch, c) => {
        await s.writers.welcomeAcked(batch, c, {
          welcomeId: welcome,
          deviceKey: B
        });
        await s.writers.deviceChanged(batch, c, A);
      }
    );
    expectSameTables(s.db, await rebuildFrom(s.relay));
  });
});

/** The per-stream check's MySQL reads, over the tables in memory. */
function verifyDb(
  db: FakeTables,
  store: InMemoryE2eeStreamStore
): E2eeStreamVerifyDb {
  return {
    rowsWhere: async (table, where) => {
      const rows = await db.rows(table, where, null);
      const target = e2eeRecordTable(table);
      return new Map(
        rows.map((row) => [e2eeRecordKeyString(target, row), row])
      );
    },
    headsPage: (after, limit) => store.listHeads(after, limit),
    outboxAfter: async (wave, afterPos) =>
      store.outboxRows.filter((row) => row.wave === wave && row.pos > afterPos)
        .length,
    backupProfiles: async () =>
      Array.from(
        new Set(
          Array.from(db.tables.get(E2EE_BACKUPS_TABLE)!.values()).map((row) =>
            String(row.profile_id)
          )
        )
      )
  };
}

describe('verifyE2eeStreams', () => {
  it('checks every stream alone, in slices, and finds none different', async () => {
    const s = await runScenario();
    const first = await verifyE2eeStreams({
      source: readerSource(s.relay),
      db: verifyDb(s.db, s.store),
      ordererDeviceKey: ORDERER.deviceKey,
      now: NOW,
      moderationKeys: MODERATION.keys,
      limit: 3
    });
    expect(first).toMatchObject({ checked: 3, failed: 0, ok: true });
    expect(first.next).not.toBeNull();
    let after = first.next;
    let checked = first.checked;
    while (after) {
      const page = await verifyE2eeStreams({
        source: readerSource(s.relay),
        db: verifyDb(s.db, s.store),
        ordererDeviceKey: ORDERER.deviceKey,
        now: NOW,
        moderationKeys: MODERATION.keys,
        after,
        limit: 3
      });
      expect(page.failures).toEqual([]);
      checked += page.checked;
      after = page.next;
    }
    expect(checked).toBe((await s.store.listHeads('', 1000)).length);
  });

  it('names the stream whose MySQL rows differ from its records', async () => {
    const s = await runScenario();
    s.db.update(
      E2EE_LOG_TABLE,
      { group_handle: G, seq: 2 },
      { epoch_fp: '0xother' }
    );
    const report = await verifyE2eeStreams({
      source: readerSource(s.relay),
      db: verifyDb(s.db, s.store),
      ordererDeviceKey: ORDERER.deviceKey,
      now: NOW,
      moderationKeys: MODERATION.keys,
      limit: 100
    });
    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({
      wave: `cv/${G}`,
      tables: [{ table: E2EE_LOG_TABLE, changed: 1 }]
    });
  });

  it("names the moderators' inbox when a report row differs", async () => {
    const s = await runScenario();
    s.db.update(E2EE_REPORTS_TABLE, { id: '0xe1' }, { on_hold: false });
    const report = await verifyE2eeStreams({
      source: readerSource(s.relay),
      db: verifyDb(s.db, s.store),
      ordererDeviceKey: ORDERER.deviceKey,
      now: NOW,
      moderationKeys: MODERATION.keys,
      limit: 100
    });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({
      wave: INBOX,
      tables: [{ table: E2EE_REPORTS_TABLE, changed: 1 }]
    });
  });

  it('reports a stream whose records wait in the outbox as lagging', async () => {
    const s = await runScenario();
    s.relay.down = true;
    await s.write(
      () =>
        s.db.update(E2EE_DEVICES_TABLE, { device_key: B }, { label: 'Tablet' }),
      (batch, c) => s.writers.deviceChanged(batch, c, B)
    );
    s.relay.down = false;
    const report = await verifyE2eeStreams({
      source: readerSource(s.relay),
      db: verifyDb(s.db, s.store),
      ordererDeviceKey: ORDERER.deviceKey,
      now: NOW,
      moderationKeys: MODERATION.keys,
      limit: 100
    });
    expect(report).toMatchObject({
      failed: 0,
      failures: [],
      lagging: 1,
      laggingStreams: [`dr/${B}`],
      ok: true
    });
  });

  it('names a stream whose head is ahead of the relays with nothing to send', async () => {
    const s = await runScenario();
    s.relay.down = true;
    await s.write(
      () =>
        s.db.update(E2EE_DEVICES_TABLE, { device_key: B }, { label: 'Tablet' }),
      (batch, c) => s.writers.deviceChanged(batch, c, B)
    );
    s.relay.down = false;
    // The record left the outbox but no relay has it: a loss.
    await s.store.deleteOutbox(s.store.outboxRows.map((row) => row.id));
    const report = await verifyE2eeStreams({
      source: readerSource(s.relay),
      db: verifyDb(s.db, s.store),
      ordererDeviceKey: ORDERER.deviceKey,
      now: NOW,
      moderationKeys: MODERATION.keys,
      limit: 100
    });
    expect(report.lagging).toBe(0);
    expect(report.failures.map((f) => f.wave)).toEqual([`dr/${B}`]);
    expect(report.failures[0].head.relays).toBe(
      (report.failures[0].head.mysql ?? 0) - 1
    );
  });
});

describe('records within the relays limits, and past their retention', () => {
  it('splits a large roster so no body passes 64 KiB, and rebuilds it whole', async () => {
    const s = await scenario();
    const group = hex('5a');
    const roster = Array.from({ length: 700 }, (_, index) => ({
      id: 1000 + index,
      group_handle: group,
      device_key: `0x${(index + 1).toString(16).padStart(64, '0')}`,
      profile_id: `p${index}`,
      joined_epoch: 0,
      added_at: T0
    }));
    await s.write(
      () => {
        s.db.put(E2EE_GROUPS_TABLE, {
          group_handle: group,
          epoch: 0,
          commit_key: hex('c0'),
          last_seq: 0,
          created_by_profile_id: 'p0',
          created_at: T0,
          updated_at: T0
        });
        for (const row of roster) s.db.put(E2EE_GROUP_ROSTER_TABLE, row);
      },
      (batch, c) => s.writers.groupCreated(batch, c, group)
    );
    const records = s.relay.stored.filter(
      (item) => item.event.wave === `cv/${group}`
    );
    expect(records.map((item) => item.event.refs[0])).toEqual([
      'genesis',
      'roster',
      'roster'
    ]);
    for (const item of records) {
      expect(Buffer.byteLength(item.event.body!)).toBeLessThan(64 * 1024);
      expect(JSON.parse(item.event.body!).windows.length).toBeLessThanOrEqual(
        E2EE_WINDOWS_PER_RECORD
      );
    }
    const stream = await rebuildE2eeStream(
      readerSource(s.relay),
      `cv/${group}`,
      {
        ordererDeviceKey: ORDERER.deviceKey,
        now: NOW
      }
    );
    expect(stream.problems).toEqual([]);
    expect(stream.tables.get(E2EE_GROUP_ROSTER_TABLE)!.size).toBe(700);
  });

  it('skips, never fails the write, a record its windows would make too big', async () => {
    const s = await scenario();
    await expect(
      s.publisher.run(s.store, (connection, batch) =>
        batch!.append(connection, {
          family: 'cv',
          owner: G,
          kind: 11,
          refs: ['roster'],
          type: 'roster',
          ops: [],
          log: {
            epoch: 0,
            windows: Array.from({ length: 1200 }, (_, index) => ({
              d: `0x${index.toString(16).padStart(64, '0')}`,
              from: 0,
              to: null
            }))
          }
        })
      )
    ).resolves.toBeUndefined();
    expect(s.store.outboxRows).toEqual([]);
    expect(s.store.head(`cv/${G}`)?.pos ?? 0).toBe(0);
  });

  it('reports a lost record content as a problem, whatever its age (R2-C)', async () => {
    const s = await scenario();
    // A revocation closing a device's roster rows in 300 groups: its
    // content is over the inline size, so it travels as a payload.
    const rows = Array.from({ length: 300 }, (_, index) => ({
      id: 5000 + index,
      group_handle: `0x${(index + 1).toString(16).padStart(64, '0')}`,
      device_key: C,
      profile_id: 'pc',
      joined_epoch: 1,
      removed_epoch: 5,
      added_at: T0 - DAY,
      removed_at: T0,
      removal_kind: 'revoke'
    }));
    await settledRun(s.publisher, s.store, (connection, batch) =>
      batch!.append(connection, {
        family: 'dv',
        owner: C,
        kind: 10,
        refs: ['revocation'],
        type: 'revocation',
        ops: rows.map((row) => ({
          op: 'put' as const,
          table: E2EE_GROUP_ROSTER_TABLE,
          row
        }))
      })
    );
    const [stored] = s.relay.stored.filter(
      (item) => item.event.wave === `dv/${C}`
    );
    s.relay.dropPayload(JSON.parse(stored.event.body!).h);
    for (const now of [NOW, NOW + 400 * DAY]) {
      const stream = await rebuildE2eeStream(readerSource(s.relay), `dv/${C}`, {
        ordererDeviceKey: ORDERER.deviceKey,
        now
      });
      expect(stream.problems.map((p) => p.reason)).toContain(
        'content is missing'
      );
    }
  });

  it('sends a DEL when a Welcome is acked; the rebuild takes it as deleted', async () => {
    const s = await scenario();
    const welcome = hex('7e', 16);
    await s.write(
      () => {
        s.db.put(E2EE_WELCOMES_TABLE, {
          id: welcome,
          group_handle: G,
          epoch: 1,
          data: Buffer.alloc(40_000, 9),
          ratchet_tree: null,
          added_by_profile_id: 'pa',
          added_by_device_key: A,
          created_at: T0
        });
        s.db.put(E2EE_WELCOME_DELIVERIES_TABLE, {
          welcome_id: welcome,
          device_key: B,
          profile_id: 'pb',
          created_at: T0
        });
      },
      (batch, c) => s.writers.welcomeStored(batch, c, welcome)
    );
    expect(s.store.itemRows).toMatchObject([
      { wave: `dv/${B}`, pos: 1, key: `welcome:${welcome}` }
    ]);
    await s.write(
      () => {
        s.db.del(E2EE_WELCOME_DELIVERIES_TABLE, { welcome_id: welcome });
        s.db.del(E2EE_WELCOMES_TABLE, { id: welcome });
      },
      (batch, c) =>
        s.writers.welcomeAcked(batch, c, { welcomeId: welcome, deviceKey: B })
    );
    expect(s.store.deletionRows).toMatchObject([
      { wave: `dv/${B}`, positions: [1] }
    ]);
    expect(await s.publisher.publishDeletions(10)).toEqual({
      queued: 1,
      done: 1
    });
    const [first, , del] = s.relay.stored.filter(
      (item) => item.event.wave === `dv/${B}`
    );
    expect(del.event).toMatchObject({ kind: 12, refs: [] });
    expect(JSON.parse(del.event.body!)).toEqual({ ids: [first.event.id] });
    // The relay dropped the Welcome's content; the index forgot it.
    expect(first.event.body).toBeNull();
    expect(s.store.deletionRows).toEqual([]);
    expect(s.store.itemRows).toEqual([]);
    const stream = await rebuildE2eeStream(readerSource(s.relay), `dv/${B}`, {
      ordererDeviceKey: ORDERER.deviceKey,
      now: NOW
    });
    expect(stream).toMatchObject({
      problems: [],
      deleted: 1,
      head: { pos: 2 }
    });
    expect(stream.tables.get(E2EE_WELCOMES_TABLE)!.size).toBe(0);
  });

  it("leaves an upload in progress and MySQL's lazy prune out of the check", async () => {
    const s = await runScenario();
    // A blob upload in progress: rows and a recorded chunk, not complete.
    const upload = hex('b2', 16);
    await s.write(
      () => {
        s.db.put(E2EE_BLOBS_TABLE, {
          blob_id: upload,
          group_handle: G,
          uploader_device_key: A,
          uploader_profile_id: 'pa',
          size: 10,
          chunk_count: 2,
          complete: false,
          created_at: NOW - 60_000,
          completed_at: null,
          storage: 'mysql',
          storage_location: null
        });
        s.db.put(E2EE_BLOB_CHUNKS_TABLE, {
          blob_id: upload,
          chunk_index: 0,
          data: Buffer.alloc(5, 1),
          size: 5,
          created_at: NOW - 60_000
        });
      },
      (batch, c) =>
        s.writers.blobChunkStored(batch, c, {
          blobId: upload,
          index: 0,
          data: Buffer.alloc(5, 1)
        })
    );
    // A message past retention that MySQL's prune has not reached yet.
    s.db.put(
      E2EE_LOG_TABLE,
      logItem(G_OLD, 1, { created_at: NOW - 100 * DAY })
    );
    const report = await verifyE2eeStreams({
      source: readerSource(s.relay),
      db: verifyDb(s.db, s.store),
      ordererDeviceKey: ORDERER.deviceKey,
      now: NOW,
      moderationKeys: MODERATION.keys,
      limit: 100
    });
    expect(report.failures).toEqual([]);
  });
});
