// The rebuild check's steps for encrypted messages and reports: a seed that
// writes encrypted DM state and reports through the real services with
// records published to the run's relay, and the rebuilder (the e2ee relay
// rebuild, write mode, slice by slice). The relay settings, with test
// identities, are the manifest's flags.
import { randomBytes } from 'node:crypto';
import { keccak256 } from 'ethers';
import { E2eeServiceDeps } from '@/api/e2ee/e2ee-context';
import { E2eeBackupsService } from '@/api/e2ee/e2ee-backups.service';
import { E2eeBlobsService } from '@/api/e2ee/e2ee-blobs.service';
import { E2eeDevicesService } from '@/api/e2ee/e2ee-devices.service';
import { E2eeGroupsService } from '@/api/e2ee/e2ee-groups.service';
import { E2eeTrustAndSafetyService } from '@/api/e2ee/e2ee-trust-and-safety.service';
import { ApiE2eeReportCategory } from '@/api/generated/models/ApiE2eeReportCategory';
import { ApiE2eeSubmitEntryRequestKindEnum } from '@/api/generated/models/ApiE2eeSubmitEntryRequest';
import { identitySubscriptionsDb } from '@/api/identity-subscriptions/identity-subscriptions.db';
import { contentModerationDb } from '@/content-moderation/content-moderation.db';
import { moderationReviewDb } from '@/content-moderation/moderation-review.db';
import { E2eeBackupDb } from '@/e2ee/e2ee-backup.db';
import { createE2eeBlobStores } from '@/e2ee/e2ee-blob-stores';
import { MysqlE2eeCiphertextStore } from '@/e2ee/e2ee-ciphertext-store';
import { e2eeDb, E2eeDeviceRow } from '@/e2ee/e2ee.db';
import {
  E2eeEntryKind,
  e2eeEntryDigest,
  e2eeRevokeDigest
} from '@/e2ee/e2ee-digests';
import {
  E2EE_CHECK_IDS,
  E2EE_CHECK_KEYS,
  E2EE_CHECK_PROFILES
} from '@/rebuild/steps/e2ee-relay.fixture';
import { e2eeRecordWriters } from '@/e2ee/relay/e2ee-record-writers';
import { runE2eeRebuild } from '@/e2ee/relay/e2ee-rebuild-run';
import { e2eeRelaySettings } from '@/e2ee/relay/e2ee-relay-config';
import { e2eeStreamPublisher } from '@/e2ee/relay/e2ee-stream-publisher';
import { MysqlE2eeStreamStore } from '@/e2ee/relay/e2ee-stream-store';
import {
  ContentModerationRecommendation,
  ContentReportReason,
  ContentReportStatus
} from '@/entities/IContentModeration';
import { dropsDb } from '@/drops/drops.db';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import { DropType } from '@/entities/IDrop';
import { waveGroupNotificationSubscriptionsDb } from '@/notifications/wave-group-notification-subscriptions.db';
import { dbSupplier } from '@/sql-executor';
import { e2eeKeyFromSeed } from '@/tests/fixtures/e2ee.fixture';
import { aWave } from '@/tests/fixtures/wave.fixture';

type TestKey = ReturnType<typeof e2eeKeyFromSeed>;

const PUBLISH_WAVES = 50;

function hexBytes(bytes: number): string {
  return `0x${randomBytes(bytes).toString('hex')}`;
}

function deviceRow(deviceKey: string, profileId: string): E2eeDeviceRow {
  const now = Date.now();
  return {
    device_key: deviceKey,
    profile_id: profileId,
    wallet: `0x${deviceKey.slice(2, 42)}`,
    ciphersuite: 78,
    grant_version: 2,
    ciphersuites: '78',
    issued_at_seconds: Math.floor(now / 1000) - 60,
    expires_at_seconds: Math.floor(now / 1000) + 86400 * 100,
    origin: 'test',
    grant_id: hexBytes(32),
    wallet_signature: `0x${'11'.repeat(65)}`,
    verified_via: 'eoa',
    label: 'Device',
    platform: 'web',
    created_at: now - 60_000,
    updated_at: now - 60_000,
    last_seen_at: now - 60_000,
    revoked_at: null,
    revoker_device_key: null,
    revocation_signed_at_seconds: null,
    revocation_signature: null,
    grant_message: null,
    notice_pending: false,
    registered_client_type: null,
    registered_binding: null,
    registered_request_origin: null,
    registered_session_id: null
  };
}

/** Ids the next `randomHex` calls hand out, so the probes can name them. */
const plannedIds: string[] = [];

function services() {
  const noEvent = async () => undefined;
  const deps: E2eeServiceDeps = {
    db: e2eeDb,
    events: {
      groupEvent: noEvent,
      welcomes: noEvent,
      deviceAdded: noEvent,
      deviceRevoked: noEvent,
      rosterChanged: noEvent,
      notifyMessage: noEvent,
      wake: noEvent
    },
    contractWalletVerifier: {
      hasCode: async () => false,
      isValidSignature: async () => false
    },
    resolveWalletProfileId: async () => null,
    now: () => Date.now(),
    random: () => 1,
    randomHex: (bytes) => plannedIds.shift() ?? hexBytes(bytes),
    attachmentsEnabled: () => true,
    admission: {
      evaluate: async (_sender, recipients) =>
        new Map(
          recipients.map((id) => [
            id,
            { allowed: true as const, recipientProfileId: id }
          ])
        )
    },
    loginGrants: {
      findGrant: async () => null,
      revokeGrant: async () => undefined
    },
    blobStores: createE2eeBlobStores({ rows: e2eeDb, env: () => ({}) }),
    records: { publisher: e2eeStreamPublisher, writers: e2eeRecordWriters }
  };
  return {
    groups: new E2eeGroupsService(deps),
    devices: new E2eeDevicesService(deps),
    blobs: new E2eeBlobsService(deps),
    backups: new E2eeBackupsService({
      e2ee: deps,
      backups: new E2eeBackupDb(dbSupplier),
      store: new MysqlE2eeCiphertextStore(dbSupplier),
      backupsEnabled: () => true
    }),
    trustAndSafety: new E2eeTrustAndSafetyService({
      db: e2eeDb,
      now: () => Date.now(),
      isModerator: async () => true,
      groupId: () => null,
      isGroupMember: async () => false
    })
  };
}

async function addDevice(key: string, profile: string): Promise<void> {
  await e2eeStreamPublisher.run(e2eeDb, async (connection, batch) => {
    await e2eeDb.insertDevice(deviceRow(key, profile), connection);
    if (batch) await e2eeRecordWriters.deviceChanged(batch, connection, key);
  });
}

type Services = ReturnType<typeof services>;

/** A commit by `a` that adds `added`, with its Welcome. */
async function commit(
  groups: Services['groups'],
  input: {
    readonly group: string;
    readonly epoch: number;
    readonly key: TestKey;
    readonly next: TestKey;
    readonly sender: string;
    readonly added: string;
  }
) {
  const data = randomBytes(2048);
  const entry = {
    epoch: input.epoch,
    kind: ApiE2eeSubmitEntryRequestKindEnum.Commit,
    data: data.toString('base64'),
    entry_hash: keccak256(data),
    epoch_commitment: hexBytes(32),
    next_commit_key: input.next.publicKey,
    sender_device_key: input.sender,
    roster_add: [input.added],
    roster_remove: [],
    welcome: {
      data: randomBytes(900).toString('base64'),
      ratchet_tree: randomBytes(300).toString('base64'),
      targets: [input.added]
    }
  };
  await groups.submitEntry(E2EE_CHECK_PROFILES.a.profileId, input.group, {
    ...entry,
    signature: input.key.sign(
      e2eeEntryDigest({
        group: input.group,
        epoch: input.epoch,
        kind: E2eeEntryKind.COMMIT,
        entryHash: entry.entry_hash,
        epochCommitment: entry.epoch_commitment,
        nextCommitKey: entry.next_commit_key,
        paddedLen: data.length
      })
    )
  });
}

/** A row as it is (objects as JSON), only the columns the table has. */
async function insertRow(table: string, row: Record<string, unknown>) {
  const known = new Set(
    (
      await dbSupplier().execute<{ name: string }>(
        `select column_name as name from information_schema.columns
         where table_schema = database() and table_name = :table`,
        { table }
      )
    ).map((column) => column.name)
  );
  const columns = Object.keys(row).filter((column) => known.has(column));
  const params = Object.fromEntries(
    columns.map((column) => {
      const value = row[column];
      return [
        column,
        value !== null && typeof value === 'object' && !(value instanceof Date)
          ? JSON.stringify(value)
          : value
      ];
    })
  );
  await dbSupplier().execute(
    `insert ignore into ${table} (${columns.map((c) => `\`${c}\``).join(', ')})
     values (${columns.map((c) => `:${c}`).join(', ')})`,
    params
  );
}

/**
 * A public wave and a drop in it (the waves tables): reports are
 * recorded only on drops known to be in a public wave. Profile a creates
 * both. The rows production's wave and drop creation write next to them
 * come from the same writers: the creator follows the wave with the ALL
 * group, the author follows the drop, and the wave's metrics count both.
 */
async function seedPublicDrop(): Promise<void> {
  const creator = E2EE_CHECK_PROFILES.a.profileId;
  const waveId = E2EE_CHECK_IDS.publicWave;
  const { serial_no: _serial, ...wave } = aWave(
    { is_direct_message: false, created_by: creator },
    { id: waveId, name: waveId }
  );
  const drop = {
    id: E2EE_CHECK_IDS.publicDrop,
    wave_id: waveId,
    author_id: creator,
    drop_type: DropType.CHAT
  };
  await insertRow('waves', wave);
  await insertRow('drops', {
    ...drop,
    created_at: Date.now(),
    updated_at: null,
    title: null,
    parts_count: 1,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    signature: null,
    hide_link_preview: false
  });
  await dbSupplier().executeNativeQueriesInTransaction(async (connection) => {
    await identitySubscriptionsDb.addIdentitySubscription(
      {
        subscriber_id: creator,
        target_id: waveId,
        target_type: ActivityEventTargetType.WAVE,
        target_action: ActivityEventAction.DROP_CREATED,
        wave_id: waveId,
        subscribed_to_all_drops: false
      },
      connection
    );
    await waveGroupNotificationSubscriptionsDb.addDefaultGroupsForWaveSubscription(
      creator,
      waveId,
      connection
    );
    await identitySubscriptionsDb.addIdentitySubscription(
      {
        subscriber_id: creator,
        target_id: drop.id,
        target_type: ActivityEventTargetType.DROP,
        target_action: ActivityEventAction.DROP_REPLIED,
        wave_id: waveId,
        subscribed_to_all_drops: false
      },
      connection
    );
    await dropsDb.applyInsertedDropMetricsDelta(drop, { connection });
  });
}

/** A moderation item as the AI capture writes it (no decision yet). */
async function insertItem(input: {
  readonly id: string;
  readonly operation: string;
  readonly scope: Record<string, unknown>;
}) {
  const now = Date.now();
  await dbSupplier().execute(
    `insert into content_moderation_items
       (id, subject_type, subject_id, author_profile_id, actor_profile_id,
        operation, policy_family, policy_version, scope, evidence,
        content_fingerprint, outcome, \`trigger\`, review_status, version,
        created_at, updated_at)
     values (:id, 'DROP', :drop, :author, :actor, :operation,
        'WAVE_CONTENT', 'rebuild-check', cast(:scope as json),
        cast(:evidence as json), :fingerprint, 'ALLOW', 'REPORT',
        'NEEDS_REVIEW', 1, :now, :now)`,
    {
      ...input,
      drop: E2EE_CHECK_IDS.publicDrop,
      author: E2EE_CHECK_PROFILES.a.profileId,
      actor: E2EE_CHECK_PROFILES.b.profileId,
      scope: JSON.stringify(input.scope),
      evidence: JSON.stringify({ text: 'reported words' }),
      fingerprint: 'f'.repeat(64),
      now
    }
  );
}

/**
 * Reports: a drop report bound to its moderation item, assessed and resolved;
 * a moderator's ALLOW on another item; a message report put on hold.
 */
async function seedReports(
  { blobs, trustAndSafety }: Services,
  input: { readonly group: string; readonly a: string; readonly b: string }
) {
  const report = await contentModerationDb.createReport(
    {
      dropId: E2EE_CHECK_IDS.publicDrop,
      reporterProfileId: E2EE_CHECK_PROFILES.b.profileId,
      authorProfileId: E2EE_CHECK_PROFILES.a.profileId,
      reason: ContentReportReason.SPAM,
      notes: 'reporter notes',
      contentSnapshot: { parts: [{ content: 'reported words' }] },
      hideDrop: true,
      blockAuthor: true
    },
    {}
  );
  const reportItem = hexBytes(32).slice(2);
  await insertItem({
    id: reportItem,
    operation: 'REPORT',
    scope: { report_id: report.id }
  });
  await moderationReviewDb.bindReport(report.id, reportItem);
  await contentModerationDb.saveReportAssessment(report.id, {
    recommendation: ContentModerationRecommendation.NEEDS_HUMAN_REVIEW,
    category: 'spam',
    confidence: 0.9512,
    rationale: 'looks like spam',
    evidence: [{ quote: 'reported words' }],
    policyVersion: 'rebuild-check'
  });
  await contentModerationDb.resolveOpenReportsForDrop({
    dropId: E2EE_CHECK_IDS.publicDrop,
    status: ContentReportStatus.RESOLVED_REMOVED,
    moderatorProfileId: 'pm',
    reason: 'removed'
  });
  await moderationReviewDb.refreshReportResolution(reportItem, {});
  const decided = hexBytes(32).slice(2);
  await insertItem({ id: decided, operation: 'CREATE', scope: {} });
  await moderationReviewDb.decide(
    await moderationReviewDb.get(decided),
    'ALLOW',
    {}
  );
  plannedIds.push(E2EE_CHECK_IDS.messageReport);
  const message = await blobs.report(E2EE_CHECK_PROFILES.b.profileId, {
    group: input.group,
    epoch: 1,
    body: randomBytes(64).toString('base64'),
    signature: `0x${'00'.repeat(64)}`,
    sender_device_key: input.a,
    reporter_device_key: input.b,
    reason: ApiE2eeReportCategory.Doxxing,
    notes: 'message report notes'
  });
  await trustAndSafety.setHold('pm', message.id, true);
}

/**
 * The fixture profiles the probes sign in as: an identity and its wallet's
 * consolidation key each (identity tables, kept through this check's drop).
 * A wallet another seed already holds stops the seed: the probes would sign
 * in as that seed's profile and fail.
 */
async function seedIdentities(): Promise<void> {
  for (const { profileId, wallet } of Object.values(E2EE_CHECK_PROFILES)) {
    await dbSupplier().execute(
      `insert ignore into identities
         (consolidation_key, profile_id, primary_address, handle,
          normalised_handle, tdh, rep, cic, level_raw, classification,
          xtdh, produced_xtdh, granted_xtdh, xtdh_rate, basetdh_rate)
       values (:wallet, :profileId, :wallet, :profileId, :profileId,
          0, 0, 0, 0, 'PSEUDONYM', 0, 0, 0, 0, 0)`,
      { wallet, profileId }
    );
    await dbSupplier().execute(
      `insert ignore into address_consolidation_keys (address, consolidation_key)
       values (:wallet, :wallet)`,
      { wallet }
    );
    const holders = await dbSupplier().execute<{ profile_id: string }>(
      `select i.profile_id from address_consolidation_keys a
       join identities i on i.consolidation_key = a.consolidation_key
       where a.address = :wallet`,
      { wallet }
    );
    if (holders.length !== 1 || holders[0].profile_id !== profileId) {
      const found = holders.map((h) => h.profile_id).join(', ') || 'nobody';
      throw new Error(
        `Wallet ${wallet} signs in as ${found}, not ${profileId}: another seed holds it`
      );
    }
  }
}

/**
 * Three devices, a group with two commits and their Welcomes, messages, an
 * attachment, a compacted backup, a revoked device, and reports: every
 * table the records carry. Keys and ids are the fixture's, so the probes
 * can name them.
 */
export async function seedE2ee(): Promise<void> {
  await seedIdentities();
  await seedPublicDrop();
  const all = services();
  const { groups, devices, blobs, backups } = all;
  const pa = E2EE_CHECK_PROFILES.a.profileId;
  const pb = E2EE_CHECK_PROFILES.b.profileId;
  const pc = E2EE_CHECK_PROFILES.c.profileId;
  const a = E2EE_CHECK_KEYS.a.publicKey;
  const b = E2EE_CHECK_KEYS.b.publicKey;
  const cKey = E2EE_CHECK_KEYS.c;
  const c = cKey.publicKey;
  await addDevice(a, pa);
  await addDevice(b, pb);
  await addDevice(c, pc);
  await devices.renameDevice(pa, a, 'Laptop');
  const group = E2EE_CHECK_IDS.group;
  await groups.createGroup(pa, {
    group,
    commit_key: E2EE_CHECK_KEYS.commit0.publicKey,
    creator_device_key: a
  });
  await commit(groups, {
    group,
    epoch: 0,
    key: E2EE_CHECK_KEYS.commit0,
    next: E2EE_CHECK_KEYS.commit1,
    sender: a,
    added: b
  });
  for (const [profile, sender] of [
    [pb, b],
    [pa, a]
  ]) {
    await groups.sendMessage(profile, group, {
      epoch: 1,
      data: randomBytes(512).toString('base64'),
      epoch_fp: '0102030405060708',
      sender_device_key: sender
    });
  }
  await commit(groups, {
    group,
    epoch: 1,
    key: E2EE_CHECK_KEYS.commit1,
    next: E2EE_CHECK_KEYS.commit2,
    sender: a,
    added: c
  });
  // c is revoked: one directory record and one inbox record.
  const revokedAt = Math.floor(Date.now() / 1000);
  await devices.revokeDevice(pc, c, {
    revoker_device_key: c,
    revoked_at: revokedAt,
    signature: cKey.sign(
      e2eeRevokeDigest({
        targetDeviceKey: c,
        revokerDeviceKey: c,
        revokedAtSeconds: revokedAt
      })
    )
  });
  plannedIds.push(E2EE_CHECK_IDS.blob);
  const blob = await blobs.createBlob(pa, {
    group,
    uploader_device_key: a,
    size: 3000,
    chunk_count: 2
  });
  await blobs.putChunk(pa, blob.blob_id, 0, {
    data: randomBytes(2000).toString('base64')
  });
  await blobs.putChunk(pa, blob.blob_id, 1, {
    data: randomBytes(1000).toString('base64')
  });
  await blobs.completeBlob(pa, blob.blob_id);
  const backupId = E2EE_CHECK_IDS.backup;
  await backups.createBackup(pa, {
    backup_id: backupId,
    envelope: randomBytes(64).toString('base64'),
    device_key: a
  });
  for (const seq of [1, 2]) {
    await backups.appendChunk(pa, backupId, {
      device_key: a,
      data: randomBytes(4096).toString('base64'),
      expected_seq: seq
    });
  }
  await backups.activate(pa, backupId, a);
  await backups.compact(pa, backupId, { device_key: a, through_seq: 1 });
  await seedReports(all, { group, a, b });
  // Mirror publishes in the background; wait, then drain what is left.
  await e2eeStreamPublisher.settled();
  await e2eeStreamPublisher.publishPending(PUBLISH_WAVES);
  const outbox = await new MysqlE2eeStreamStore(dbSupplier).countOutbox();
  if (outbox.rows)
    throw new Error(`${outbox.rows} records are still in the outbox`);
}

/** The tables from the relays, write mode, every slice. */
export async function rebuildE2ee(): Promise<void> {
  let after: string | undefined;
  do {
    const report = await runE2eeRebuild({
      mode: 'write',
      now: Date.now(),
      settings: e2eeRelaySettings(),
      after,
      // The check keeps the DEL queue (EPHEMERAL) through its drop, and a
      // rebuilder writes only INDEX tables.
      queueDeletions: false
    });
    if (!report.ok) {
      throw new Error(
        `The e2ee rebuild found problems: ${JSON.stringify(report).slice(0, 2000)}`
      );
    }
    after = report.next ?? undefined;
  } while (after !== undefined);
}
