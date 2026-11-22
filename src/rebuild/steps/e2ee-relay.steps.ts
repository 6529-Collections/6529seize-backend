// The rebuild check's steps for encrypted messages: a seed that writes
// encrypted DM state through the delivery service with records published to
// the run's relay, and the rebuilder (the e2ee relay rebuild, write mode).
// The relay settings, with test identities, are the manifest's flags.
import { randomBytes } from 'node:crypto';
import { keccak256 } from 'ethers';
import { E2eeServiceDeps } from '@/api/e2ee/e2ee-context';
import { E2eeBackupsService } from '@/api/e2ee/e2ee-backups.service';
import { E2eeBlobsService } from '@/api/e2ee/e2ee-blobs.service';
import { E2eeDevicesService } from '@/api/e2ee/e2ee-devices.service';
import { E2eeGroupsService } from '@/api/e2ee/e2ee-groups.service';
import { ApiE2eeSubmitEntryRequestKindEnum } from '@/api/generated/models/ApiE2eeSubmitEntryRequest';
import { E2eeBackupDb } from '@/e2ee/e2ee-backup.db';
import { createE2eeBlobStores } from '@/e2ee/e2ee-blob-stores';
import { MysqlE2eeCiphertextStore } from '@/e2ee/e2ee-ciphertext-store';
import { e2eeDb, E2eeDeviceRow } from '@/e2ee/e2ee.db';
import { E2eeEntryKind, e2eeEntryDigest } from '@/e2ee/e2ee-digests';
import { e2eeRecordWriters } from '@/e2ee/relay/e2ee-record-writers';
import { runE2eeRebuild } from '@/e2ee/relay/e2ee-rebuild-run';
import { e2eeRelaySettings } from '@/e2ee/relay/e2ee-relay-config';
import { e2eeStreamPublisher } from '@/e2ee/relay/e2ee-stream-publisher';
import { MysqlE2eeStreamStore } from '@/e2ee/relay/e2ee-stream-store';
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
    })
  };
}

async function addDevice(key: string, profile: string): Promise<void> {
  await e2eeStreamPublisher.run(e2eeDb, async (connection, batch) => {
    await e2eeDb.insertDevice(deviceRow(key, profile), connection);
    if (batch) await e2eeRecordWriters.deviceChanged(batch, connection, key);
  });
}

/**
 * Two devices, a group with a commit and a welcome, two messages, an
 * attachment and a compacted backup: every table the records carry.
 */
export async function seedE2ee(): Promise<void> {
  const { groups, devices, blobs, backups } = services();
  const a = randomE2eeKey().publicKey;
  const b = randomE2eeKey().publicKey;
  await addDevice(a, 'pa');
  await addDevice(b, 'pb');
  await devices.renameDevice('pa', a, 'Laptop');
  const group = randomE2eeGroupHandle();
  const k0 = randomE2eeKey();
  const k1 = randomE2eeKey();
  await groups.createGroup('pa', {
    group,
    commit_key: k0.publicKey,
    creator_device_key: a
  });
  const data = randomBytes(2048);
  const entry = {
    epoch: 0,
    kind: ApiE2eeSubmitEntryRequestKindEnum.Commit,
    data: data.toString('base64'),
    entry_hash: keccak256(data),
    epoch_commitment: hexBytes(32),
    next_commit_key: k1.publicKey,
    sender_device_key: a,
    roster_add: [b],
    roster_remove: [],
    welcome: {
      data: randomBytes(900).toString('base64'),
      ratchet_tree: randomBytes(300).toString('base64'),
      targets: [b]
    }
  };
  await groups.submitEntry('pa', group, {
    ...entry,
    signature: k0.sign(
      e2eeEntryDigest({
        group,
        epoch: 0,
        kind: E2eeEntryKind.COMMIT,
        entryHash: entry.entry_hash,
        epochCommitment: entry.epoch_commitment,
        nextCommitKey: entry.next_commit_key,
        paddedLen: data.length
      })
    )
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
  await e2eeStreamPublisher.publishPending(PUBLISH_WAVES);
  const outbox = await new MysqlE2eeStreamStore(dbSupplier).countOutbox();
  if (outbox.rows)
    throw new Error(`${outbox.rows} records are still in the outbox`);
}

/** The delivery service's tables from the relays, write mode. */
export async function rebuildE2ee(): Promise<void> {
  const report = await runE2eeRebuild({
    mode: 'write',
    now: Date.now(),
    settings: e2eeRelaySettings()
  });
  if (!report.ok) {
    throw new Error(
      `The e2ee rebuild found problems: ${JSON.stringify(report).slice(0, 2000)}`
    );
  }
}
