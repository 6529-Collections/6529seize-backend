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
import { contentModerationDb } from '@/content-moderation/content-moderation.db';
import { E2eeBackupDb } from '@/e2ee/e2ee-backup.db';
import { createE2eeBlobStores } from '@/e2ee/e2ee-blob-stores';
import { MysqlE2eeCiphertextStore } from '@/e2ee/e2ee-ciphertext-store';
import { e2eeDb, E2eeDeviceRow } from '@/e2ee/e2ee.db';
import {
  E2eeEntryKind,
  e2eeEntryDigest,
  e2eeRevokeDigest
} from '@/e2ee/e2ee-digests';
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
import { dbSupplier } from '@/sql-executor';
import {
  randomE2eeGroupHandle,
  randomE2eeKey
} from '@/tests/fixtures/e2ee.fixture';

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
    randomHex: (bytes) => hexBytes(bytes),
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
    readonly key: ReturnType<typeof randomE2eeKey>;
    readonly next: ReturnType<typeof randomE2eeKey>;
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
  await groups.submitEntry('pa', input.group, {
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

/** Reports: a drop report assessed and resolved; a message report put on hold. */
async function seedReports(
  { blobs, trustAndSafety }: Services,
  input: { readonly group: string; readonly a: string; readonly b: string }
) {
  const report = await contentModerationDb.createReport(
    {
      dropId: 'rebuild-check-drop',
      reporterProfileId: 'pb',
      authorProfileId: 'pa',
      reason: ContentReportReason.SPAM,
      notes: 'reporter notes',
      contentSnapshot: { parts: [{ content: 'reported words' }] }
    },
    {}
  );
  await contentModerationDb.saveReportAssessment(report.id, {
    recommendation: ContentModerationRecommendation.NEEDS_HUMAN_REVIEW,
    category: 'spam',
    confidence: 0.9512,
    rationale: 'looks like spam',
    evidence: [{ quote: 'reported words' }],
    policyVersion: 'rebuild-check'
  });
  await contentModerationDb.resolveOpenReportsForDrop({
    dropId: 'rebuild-check-drop',
    status: ContentReportStatus.RESOLVED_REMOVED,
    moderatorProfileId: 'pm',
    reason: 'removed'
  });
  const message = await blobs.report('pb', {
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
 * Three devices, a group with two commits and their Welcomes, messages, an
 * attachment, a compacted backup, a revoked device, and reports: every
 * table the records carry.
 */
export async function seedE2ee(): Promise<void> {
  const all = services();
  const { groups, devices, blobs, backups } = all;
  const a = randomE2eeKey().publicKey;
  const b = randomE2eeKey().publicKey;
  const cKey = randomE2eeKey();
  const c = cKey.publicKey;
  await addDevice(a, 'pa');
  await addDevice(b, 'pb');
  await addDevice(c, 'pc');
  await devices.renameDevice('pa', a, 'Laptop');
  const group = randomE2eeGroupHandle();
  const keys = [randomE2eeKey(), randomE2eeKey(), randomE2eeKey()];
  await groups.createGroup('pa', {
    group,
    commit_key: keys[0].publicKey,
    creator_device_key: a
  });
  await commit(groups, {
    group,
    epoch: 0,
    key: keys[0],
    next: keys[1],
    sender: a,
    added: b
  });
  for (const [profile, sender] of [
    ['pb', b],
    ['pa', a]
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
    key: keys[1],
    next: keys[2],
    sender: a,
    added: c
  });
  // c is revoked: one directory record and one inbox record.
  const revokedAt = Math.floor(Date.now() / 1000);
  await devices.revokeDevice('pc', c, {
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
  const blob = await blobs.createBlob('pa', {
    group,
    uploader_device_key: a,
    size: 3000,
    chunk_count: 2
  });
  await blobs.putChunk('pa', blob.blob_id, 0, {
    data: randomBytes(2000).toString('base64')
  });
  await blobs.putChunk('pa', blob.blob_id, 1, {
    data: randomBytes(1000).toString('base64')
  });
  await blobs.completeBlob('pa', blob.blob_id);
  const backupId = hexBytes(16);
  await backups.createBackup('pa', {
    backup_id: backupId,
    envelope: randomBytes(64).toString('base64'),
    device_key: a
  });
  for (const seq of [1, 2]) {
    await backups.appendChunk('pa', backupId, {
      device_key: a,
      data: randomBytes(4096).toString('base64'),
      expected_seq: seq
    });
  }
  await backups.activate('pa', backupId, a);
  await backups.compact('pa', backupId, { device_key: a, through_seq: 1 });
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
      after
    });
    if (!report.ok) {
      throw new Error(
        `The e2ee rebuild found problems: ${JSON.stringify(report).slice(0, 2000)}`
      );
    }
    after = report.next ?? undefined;
  } while (after !== undefined);
}
