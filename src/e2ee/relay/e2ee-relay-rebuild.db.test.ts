import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { keccak256 } from 'ethers';
import { E2eeServiceDeps } from '@/api/e2ee/e2ee-context';
import { E2eeBackupsService } from '@/api/e2ee/e2ee-backups.service';
import { E2eeBlobsService } from '@/api/e2ee/e2ee-blobs.service';
import { E2eeDevicesService } from '@/api/e2ee/e2ee-devices.service';
import { E2eeGroupsService } from '@/api/e2ee/e2ee-groups.service';
import { ApiE2eeSubmitEntryRequestKindEnum } from '@/api/generated/models/ApiE2eeSubmitEntryRequest';
import {
  E2EE_RELAY_OUTBOX_TABLE,
  E2EE_STREAMS_TABLE
} from '@/constants/db-tables';
import { E2eeBackupDb } from '@/e2ee/e2ee-backup.db';
import { createE2eeBlobStores } from '@/e2ee/e2ee-blob-stores';
import { MysqlE2eeCiphertextStore } from '@/e2ee/e2ee-ciphertext-store';
import { E2eeDb, E2eeDeviceRow } from '@/e2ee/e2ee.db';
import { E2eeEntryKind, e2eeEntryDigest } from '@/e2ee/e2ee-digests';
import { E2EE_RECORD_TABLES } from '@/e2ee/relay/e2ee-record-tables';
import { E2eeRecordWriters } from '@/e2ee/relay/e2ee-record-writers';
import { E2eeRebuildDb } from '@/e2ee/relay/e2ee-rebuild.db';
import {
  relayE2eeRebuildSource,
  runE2eeRebuild,
  runE2eeStreamVerify
} from '@/e2ee/relay/e2ee-rebuild-run';
import {
  backfillE2eeRecords,
  E2EE_BACKFILL_FAMILIES,
  E2eeBackfillDeps,
  MysqlE2eeBackfillDb
} from '@/e2ee/relay/e2ee-relay-backfill';
import { E2eeRelaySettings } from '@/e2ee/relay/e2ee-relay-config';
import { E2eeRelayPool } from '@/e2ee/relay/e2ee-relay-pool';
import {
  E2eeStreamPublisher,
  relayHeadAnchorSource
} from '@/e2ee/relay/e2ee-stream-publisher';
import { MysqlE2eeStreamStore } from '@/e2ee/relay/e2ee-stream-store';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  randomE2eeGroupHandle,
  randomE2eeKey
} from '@/tests/fixtures/e2ee.fixture';
import { MockCrpRelay } from '@/tests/fixtures/e2ee-mock-crp-relay.fixture';
import { e2eeTestRelayIdentity } from '@/tests/fixtures/e2ee-stream-store.fixture';

const NET = '6529-interim-test';
const ORDERER = e2eeTestRelayIdentity(7, `0x${'aa'.repeat(20)}`);
const READER = e2eeTestRelayIdentity(9, `0x${'bb'.repeat(20)}`);
const NOW = 1_795_000_000_000;

function hexBytes(bytes: number) {
  return `0x${randomBytes(bytes).toString('hex')}`;
}

function deviceRow(deviceKey: string, profileId: string): E2eeDeviceRow {
  return {
    device_key: deviceKey,
    profile_id: profileId,
    wallet: `0x${deviceKey.slice(2, 42)}`,
    ciphersuite: 78,
    grant_version: 2,
    ciphersuites: '78',
    issued_at_seconds: Math.floor(NOW / 1000) - 60,
    expires_at_seconds: Math.floor(NOW / 1000) + 86400 * 100,
    origin: 'test',
    grant_id: hexBytes(32),
    wallet_signature: `0x${'11'.repeat(65)}`,
    verified_via: 'eoa',
    label: 'Device',
    platform: 'web',
    created_at: NOW - 60_000,
    updated_at: NOW - 60_000,
    last_seen_at: NOW - 60_000,
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

/** Drops the activity stamp the rebuild derives (`last_seen_at`). */
function withoutActivity(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, field) =>
      key === 'last_seen_at' ? undefined : field
    )
  );
}

describeWithSeed('e2ee relay records against MySQL', [], () => {
  let relay: MockCrpRelay;
  let settings: E2eeRelaySettings;
  let deps: E2eeServiceDeps;
  let db: E2eeDb;
  let groups: E2eeGroupsService;
  let devices: E2eeDevicesService;
  let blobs: E2eeBlobsService;
  let backups: E2eeBackupsService;
  let writers: E2eeRecordWriters;
  let publisher: E2eeStreamPublisher;
  let store: MysqlE2eeStreamStore;

  beforeEach(() => {
    relay = new MockCrpRelay({
      url: 'wss://relay.test',
      net: NET,
      head: 9000,
      roles: {
        [ORDERER.grant.wallet]: ['orderer'],
        [READER.grant.wallet]: ['site-reader']
      }
    });
    settings = {
      mode: 'mirror',
      urls: [relay.options.url],
      net: NET,
      quorum: 1,
      orderer: ORDERER,
      ordererPublicKey: ORDERER.deviceKey,
      siteReader: READER
    };
    const pool = new E2eeRelayPool({
      urls: settings.urls,
      net: NET,
      identity: ORDERER,
      open: () => relay.connect()
    });
    store = new MysqlE2eeStreamStore(() => sqlExecutor);
    let clock = NOW;
    publisher = new E2eeStreamPublisher({
      settings: () => settings,
      store,
      pool: () => pool,
      anchors: relayHeadAnchorSource(() => pool),
      now: () => clock++,
      random: () => 1
    });
    db = new E2eeDb(() => sqlExecutor);
    writers = new E2eeRecordWriters();
    const noEvent = async () => undefined;
    deps = {
      db,
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
      now: () => NOW,
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
      blobStores: createE2eeBlobStores({ rows: db, env: () => ({}) }),
      records: { publisher, writers }
    };
    groups = new E2eeGroupsService(deps);
    devices = new E2eeDevicesService(deps);
    blobs = new E2eeBlobsService(deps);
    backups = new E2eeBackupsService({
      e2ee: deps,
      backups: new E2eeBackupDb(() => sqlExecutor),
      store: new MysqlE2eeCiphertextStore(() => sqlExecutor),
      backupsEnabled: () => true
    });
  });

  async function addDevice(key: string, profile: string) {
    await publisher.run(db, async (connection, batch) => {
      await db.insertDevice(deviceRow(key, profile), connection);
      if (batch) await writers.deviceChanged(batch, connection, key);
    });
  }

  async function story() {
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
    for (const sender of [b, a]) {
      await groups.sendMessage(sender === a ? 'pa' : 'pb', group, {
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
    return { a, b, group, blobId: blob.blob_id, backupId };
  }

  async function answers(ids: Awaited<ReturnType<typeof story>>) {
    return withoutActivity({
      logA: await groups.getLog('pa', ids.group, { device_key: ids.a }),
      logB: await groups.getLog('pb', ids.group, { device_key: ids.b }),
      group: await groups.getGroup('pa', ids.group, ids.a),
      deviceGroups: await groups.getDeviceGroups('pb', ids.b),
      inbox: await groups.getDeviceInboxStatus('pb', ids.b),
      welcomes: await groups.getWelcomes('pb', ids.b),
      devices: await devices.getProfileDevices('pa'),
      device: await devices.getDevice(ids.b),
      chunk0: await blobs.getChunk('pb', ids.blobId, 0, ids.b),
      chunk1: await blobs.getChunk('pb', ids.blobId, 1, ids.b),
      backup: await backups.getBackup('pa', ids.backupId),
      backupChunks: await backups.listChunks('pa', ids.backupId, {}),
      backupChunk: await backups.getChunk('pa', ids.backupId, 2)
    });
  }

  async function emptyTables() {
    for (const table of [
      ...Object.keys(E2EE_RECORD_TABLES),
      E2EE_STREAMS_TABLE,
      E2EE_RELAY_OUTBOX_TABLE
    ]) {
      await sqlExecutor.execute(`delete from ${table}`);
    }
  }

  function rebuild(mode: 'verify' | 'write') {
    return runE2eeRebuild({
      mode,
      now: NOW,
      settings,
      db: new E2eeRebuildDb(() => sqlExecutor),
      source: relayE2eeRebuildSource(
        new E2eeRelayPool({
          urls: settings.urls,
          net: NET,
          identity: READER,
          open: () => relay.connect()
        })
      )
    });
  }

  it('drops every table, rebuilds from the relays, and the API answers the same', async () => {
    const ids = await story();
    expect((await store.countOutbox()).rows).toBe(0);
    const before = await answers(ids);

    const verify = await rebuild('verify');
    expect(verify.problems).toEqual([]);
    expect(
      verify.tables?.filter((t) => t.missing + t.extra + t.changed)
    ).toEqual([]);
    expect(verify.heads).toMatchObject({ missing: 0, behind: 0, differ: 0 });
    expect(verify.ok).toBe(true);

    await emptyTables();
    const write = await rebuild('write');
    expect(write).toMatchObject({ written: true, ok: true, problemCount: 0 });
    expect(await answers(ids)).toEqual(before);

    // The rebuilt index keeps working: the next record extends the chain.
    await groups.sendMessage('pb', ids.group, {
      epoch: 1,
      data: randomBytes(512).toString('base64'),
      epoch_fp: '0102030405060708',
      sender_device_key: ids.b
    });
    expect((await rebuild('verify')).ok).toBe(true);
  });

  it('refuses to write into tables that are not empty', async () => {
    await story();
    await expect(rebuild('write')).rejects.toThrow('only into empty tables');
  });

  it('primary mode: a write the relays do not confirm changes nothing', async () => {
    const a = randomE2eeKey().publicKey;
    await addDevice(a, 'pa');
    settings = { ...settings, mode: 'primary' };
    relay.down = true;
    relay.disconnectAll();
    await expect(devices.renameDevice('pa', a, 'Phone')).rejects.toMatchObject({
      e2eeCode: 'E2EE_RELAYS_UNAVAILABLE'
    });
    expect((await db.getDevice(a))?.label).toBe('Device');
    relay.down = false;
    await devices.renameDevice('pa', a, 'Phone');
    expect((await db.getDevice(a))?.label).toBe('Phone');
    expect((await store.countOutbox()).rows).toBe(0);
  });
  it('backfills what was written while records were off, and verify passes', async () => {
    settings = { ...settings, mode: 'off' };
    const ids = await story();
    expect(relay.stored).toEqual([]);
    settings = { ...settings, mode: 'mirror' };
    const backfillDb = new MysqlE2eeBackfillDb(() => sqlExecutor);
    const blobStores = createE2eeBlobStores({ rows: db, env: () => ({}) });
    const ciphertexts = new MysqlE2eeCiphertextStore(() => sqlExecutor);
    const deps: E2eeBackfillDeps = {
      db: backfillDb,
      writers,
      run: (work) =>
        publisher.run(backfillDb, (connection, batch) =>
          work(connection, batch!)
        ),
      blobChunk: (blob, index) =>
        blobStores.forBlob(blob).getChunk(blob.blob_id, index),
      backupObject: (key) => ciphertexts.get(key),
      now: () => NOW
    };
    const dryRun = await backfillE2eeRecords(deps, {
      live: false,
      family: 'cv',
      limit: 10
    });
    expect(dryRun.volume).toMatchObject({
      groups: 1,
      entries: 1,
      messages: 2,
      pendingWelcomes: 1,
      devices: 2,
      completeBlobs: 1,
      blobBytes: 3000,
      backups: 1,
      backupChunks: 1,
      backupBytes: 4096
    });
    for (const family of E2EE_BACKFILL_FAMILIES) {
      let after: string | undefined;
      do {
        const report = await backfillE2eeRecords(deps, {
          live: true,
          family,
          after,
          limit: 1
        });
        expect(report.skipped).toEqual([]);
        after = report.next ?? undefined;
      } while (after !== undefined);
    }
    const verify = await rebuild('verify');
    expect(verify.problems).toEqual([]);
    expect(
      verify.tables?.filter((t) => t.missing + t.extra + t.changed)
    ).toEqual([]);
    expect(verify.ok).toBe(true);
    const before = await answers(ids);
    await emptyTables();
    expect((await rebuild('write')).ok).toBe(true);
    expect(await answers(ids)).toEqual(before);
  });
  it('checks stream by stream against MySQL, and names a changed row', async () => {
    const ids = await story();
    const verify = (after?: string) =>
      runE2eeStreamVerify({
        now: NOW,
        settings,
        after,
        limit: 2,
        db: new E2eeRebuildDb(() => sqlExecutor),
        source: relayE2eeRebuildSource(
          new E2eeRelayPool({
            urls: settings.urls,
            net: NET,
            identity: READER,
            open: () => relay.connect()
          })
        )
      });
    let after: string | undefined;
    let checked = 0;
    do {
      const page = await verify(after);
      expect(page.failures).toEqual([]);
      checked += page.checked;
      after = page.next ?? undefined;
    } while (after !== undefined);
    // dr for each device, cv, dv, bl and bk.
    expect(checked).toBe(6);
    await sqlExecutor.execute(
      `update e2ee_log set epoch_fp = 'ffffffffffffffff' where group_handle = :group and seq = 2`,
      { group: ids.group }
    );
    const failures = [];
    after = undefined;
    do {
      const page = await verify(after);
      failures.push(...page.failures);
      after = page.next ?? undefined;
    } while (after !== undefined);
    expect(failures.map((f) => f.wave)).toEqual([`cv/${ids.group}`]);
  });
});
