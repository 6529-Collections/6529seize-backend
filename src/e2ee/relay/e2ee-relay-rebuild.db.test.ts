import 'reflect-metadata';
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
import {
  CONTENT_MODERATION_REPORTS_TABLE,
  DELETED_DROPS_TABLE,
  DROPS_TABLE,
  E2EE_RELAY_OUTBOX_TABLE,
  E2EE_STREAMS_TABLE
} from '@/constants/db-tables';
import { ContentModerationDb } from '@/content-moderation/content-moderation.db';
import { ModerationReviewDb } from '@/content-moderation/moderation-review.db';
import { E2eeBackupDb } from '@/e2ee/e2ee-backup.db';
import { createE2eeBlobStores } from '@/e2ee/e2ee-blob-stores';
import { MysqlE2eeCiphertextStore } from '@/e2ee/e2ee-ciphertext-store';
import { E2eeDb, E2eeDeviceRow } from '@/e2ee/e2ee.db';
import {
  E2eeEntryKind,
  e2eeEntryDigest,
  e2eeRevokeDigest
} from '@/e2ee/e2ee-digests';
import { E2eeModerationRecorder } from '@/e2ee/relay/e2ee-moderation-records';
import { E2EE_RECORD_TABLES } from '@/e2ee/relay/e2ee-record-tables';
import {
  E2eeRecordRowReader,
  E2eeRecordWriters
} from '@/e2ee/relay/e2ee-record-writers';
import { E2eeRebuildDb } from '@/e2ee/relay/e2ee-rebuild.db';
import {
  relayE2eeRebuildSource,
  E2eeRebuildReport,
  runE2eeRebuild
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
import {
  ContentModerationRecommendation,
  ContentReportReason,
  ContentReportStatus
} from '@/entities/IContentModeration';
import { DropType } from '@/entities/IDrop';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  randomE2eeGroupHandle,
  randomE2eeKey
} from '@/tests/fixtures/e2ee.fixture';
import { MockCrpRelay } from '@/tests/fixtures/e2ee-mock-crp-relay.fixture';
import {
  e2eeTestModerationKey,
  e2eeTestRelayIdentity,
  settledRun
} from '@/tests/fixtures/e2ee-stream-store.fixture';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';

const NET = '6529-interim-test';
const ORDERER = e2eeTestRelayIdentity(7, `0x${'aa'.repeat(20)}`);
const READER = e2eeTestRelayIdentity(9, `0x${'bb'.repeat(20)}`);
const NOW = 1_795_000_000_000;
const MODERATION = e2eeTestModerationKey(0x31);

/** A legacy plaintext DM: its reports stay off the relays (D153). */
const dmGroup = aUserGroup({ is_direct_message: true });
const dmWave = aWave({ is_direct_message: true, chat_group_id: dmGroup.id });
const DM_DROP = 'drop-in-a-legacy-dm';
const PUBLIC_DROP = 'drop-in-a-public-wave';
const publicWave = aWave({ is_direct_message: false });
/** Author deletes are hard deletes: only `deleted_drops` keeps the wave. */
const DELETED_DM_DROP = 'deleted-drop-in-a-legacy-dm';
const DELETED_PUBLIC_DROP = 'deleted-drop-in-a-public-wave';
/** A drop whose DM wave was deleted too: neither table knows the wave. */
const DROP_OF_DELETED_WAVE = 'deleted-drop-of-a-deleted-dm-wave';

function dropRow(serialNo: number, id: string, waveId: string) {
  return {
    serial_no: serialNo,
    id,
    wave_id: waveId,
    author_id: 'pa',
    created_at: NOW,
    updated_at: null,
    title: null,
    parts_count: 1,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    drop_type: DropType.CHAT,
    signature: null,
    hide_link_preview: false
  };
}

function deletedDrop(id: string, waveId: string) {
  return {
    id,
    wave_id: waveId,
    author_id: 'pa',
    created_at: NOW - 1000,
    deleted_at: NOW - 500
  };
}

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

const SEEDS = [
  withUserGroups([dmGroup]),
  withWaves([dmWave, publicWave]),
  {
    table: DROPS_TABLE,
    rows: [
      dropRow(1, DM_DROP, dmWave.id),
      dropRow(2, PUBLIC_DROP, publicWave.id)
    ]
  },
  {
    table: DELETED_DROPS_TABLE,
    rows: [
      deletedDrop(DELETED_DM_DROP, dmWave.id),
      deletedDrop(DELETED_PUBLIC_DROP, publicWave.id),
      deletedDrop(DROP_OF_DELETED_WAVE, 'a-deleted-dm-wave')
    ]
  }
];

describeWithSeed('e2ee relay records against MySQL', SEEDS, () => {
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
  let moderation: ContentModerationDb;
  let review: ModerationReviewDb;
  let trustAndSafety: E2eeTrustAndSafetyService;

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
      siteReader: READER,
      moderation: MODERATION.recipient,
      moderationKeys: MODERATION.keys
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
    writers = new E2eeRecordWriters();
    const reportRecords = new E2eeModerationRecorder(() => ({
      publisher,
      writers,
      runner: new E2eeRecordRowReader(() => sqlExecutor)
    }));
    db = new E2eeDb(() => sqlExecutor, reportRecords);
    moderation = new ContentModerationDb(() => sqlExecutor, reportRecords);
    review = new ModerationReviewDb(() => sqlExecutor, reportRecords);
    trustAndSafety = new E2eeTrustAndSafetyService({
      db,
      now: () => NOW,
      isModerator: async () => true,
      groupId: () => null,
      isGroupMember: async () => false
    });
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
    await settledRun(publisher, db, async (connection, batch) => {
      await db.insertDevice(deviceRow(key, profile), connection);
      if (batch) await writers.deviceChanged(batch, connection, key);
    });
  }

  async function story() {
    const a = randomE2eeKey().publicKey;
    const bKey = randomE2eeKey();
    const b = bKey.publicKey;
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
    await publisher.settled();
    return { a, b, bKey, group, blobId: blob.blob_id, backupId };
  }

  /**
   * Reports: a drop report assessed by the AI and resolved; a report
   * on a legacy DM; a message report put on hold (a trust-and-safety read).
   */
  async function reportStory(ids: Awaited<ReturnType<typeof story>>) {
    const reported = {
      reporterProfileId: 'pb',
      authorProfileId: 'pa',
      reason: ContentReportReason.SPAM,
      notes: 'the reporter notes',
      contentSnapshot: { parts: [{ content: 'reported words' }], n: 1 }
    };
    const report = await moderation.createReport(
      { ...reported, dropId: PUBLIC_DROP },
      {}
    );
    await moderation.saveReportAssessment(report.id, {
      recommendation: ContentModerationRecommendation.NEEDS_HUMAN_REVIEW,
      category: 'spam',
      confidence: 0.9512,
      rationale: 'looks like spam',
      evidence: [{ quote: 'reported words' }],
      policyVersion: 'test-1'
    });
    await moderation.resolveOpenReportsForDrop({
      dropId: PUBLIC_DROP,
      status: ContentReportStatus.RESOLVED_REMOVED,
      moderatorProfileId: 'pm',
      reason: 'removed'
    });
    const dmReport = await moderation.createReport(
      { ...reported, dropId: DM_DROP },
      {}
    );
    // Reports on deleted drops: a moderator resolves them as deleted,
    // which records them unless the drop was a DM's.
    const deletedReports: Record<string, string> = {};
    for (const dropId of [
      DELETED_DM_DROP,
      DROP_OF_DELETED_WAVE,
      DELETED_PUBLIC_DROP
    ]) {
      deletedReports[dropId] = (
        await moderation.createReport({ ...reported, dropId }, {})
      ).id;
      await review.resolveDeletedReports(dropId, 'pm', 'deleted', {});
    }
    const message = await blobs.report('pb', {
      group: ids.group,
      epoch: 1,
      body: randomBytes(64).toString('base64'),
      signature: `0x${'00'.repeat(64)}`,
      sender_device_key: ids.a,
      reporter_device_key: ids.b,
      reason: ApiE2eeReportCategory.Doxxing,
      notes: 'message report notes'
    });
    await trustAndSafety.setHold('pm', message.id, true);
    await publisher.settled();
    return {
      reportId: report.id,
      dmReportId: dmReport.id,
      messageReportId: message.id,
      deletedReports
    };
  }

  async function reportAnswers(ids: Awaited<ReturnType<typeof reportStory>>) {
    const accessLog = await db.listReportAccess();
    return {
      report: await review.reportForReview(ids.reportId),
      messageReports: (await db.listReportsForReview(null, 10)).map((row) => ({
        ...row
      })),
      accessLog: accessLog.map((row) => ({ ...row }))
    };
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
      E2EE_RELAY_OUTBOX_TABLE,
      'e2ee_record_items',
      'e2ee_relay_deletions'
    ]) {
      await sqlExecutor.execute(`delete from ${table}`);
    }
  }

  function slice(
    mode: 'verify' | 'write',
    after?: string,
    extra: Partial<Parameters<typeof runE2eeRebuild>[0]> = {}
  ) {
    return runE2eeRebuild({
      mode,
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
      ),
      ...extra
    });
  }

  /** Every slice of a run, as an operator runs them. */
  async function rebuild(
    mode: 'verify' | 'write',
    extra: Partial<Parameters<typeof runE2eeRebuild>[0]> = {}
  ) {
    const slices: E2eeRebuildReport[] = [];
    let after: string | undefined;
    do {
      const report = await slice(mode, after, extra);
      slices.push(report);
      after = report.next ?? undefined;
    } while (after !== undefined);
    return {
      slices: slices.length,
      streams: slices.reduce((sum, report) => sum + report.streams, 0),
      coverage: slices[0].coverage,
      failures: slices.flatMap((report) => report.failures ?? []),
      laggingStreams: slices.flatMap((report) => report.laggingStreams ?? []),
      problems: slices.flatMap((report) => report.problems),
      ok: slices.every((report) => report.ok)
    };
  }

  it('drops every table, rebuilds from the relays, and the API answers the same', async () => {
    const ids = await story();
    const reports = await reportStory(ids);
    expect((await store.countOutbox()).rows).toBe(0);
    const before = await answers(ids);
    const reportsBefore = await reportAnswers(reports);
    expect(reportsBefore.report).toMatchObject({
      status: ContentReportStatus.RESOLVED_REMOVED,
      content_snapshot: { parts: [{ content: 'reported words' }], n: 1 },
      ai_evidence: [{ quote: 'reported words' }]
    });
    expect(Number(reportsBefore.report.ai_confidence)).toBe(0.9512);
    expect(reportsBefore.messageReports[0]).toMatchObject({ on_hold: true });
    // The report records are sealed: no relay holds a report in the clear.
    for (const item of relay.stored) {
      expect(item.event.body ?? '').not.toContain('reporter notes');
      expect(item.event.body ?? '').not.toContain('message report notes');
    }

    const verify = await rebuild('verify');
    expect(verify.failures).toEqual([]);
    expect(verify.coverage).toMatchObject({ missing: 0 });
    expect(verify.ok).toBe(true);

    await emptyTables();
    const write = await rebuild('write');
    expect(write).toMatchObject({ ok: true, problems: [] });
    expect(write.streams).toBe(7);
    expect(await answers(ids)).toEqual(before);
    expect(await reportAnswers(reports)).toEqual(reportsBefore);
    // Reports on legacy DMs, live or deleted, and on a drop whose wave is
    // gone, were never recorded, so they are not rebuilt; the report on a
    // deleted public drop is.
    const rebuiltReports = await sqlExecutor.execute<{ id: string }>(
      `select id from ${CONTENT_MODERATION_REPORTS_TABLE} where id in (:ids)`,
      {
        ids: [reports.dmReportId, ...Object.values(reports.deletedReports)]
      }
    );
    expect(rebuiltReports.map((row) => row.id)).toEqual([
      reports.deletedReports[DELETED_PUBLIC_DROP]
    ]);

    // The rebuilt index keeps working: the next record extends the chain.
    await groups.sendMessage('pb', ids.group, {
      epoch: 1,
      data: randomBytes(512).toString('base64'),
      epoch_fp: '0102030405060708',
      sender_device_key: ids.b
    });
    await publisher.settled();
    expect((await rebuild('verify')).ok).toBe(true);
  });

  it('refuses to write into tables that are not empty', async () => {
    await story();
    await expect(slice('write')).rejects.toThrow('only into empty tables');
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
    await publisher.settled();
    expect((await db.getDevice(a))?.label).toBe('Phone');
    expect((await store.countOutbox()).rows).toBe(0);
  });
  it('backfills what was written while records were off, and verify passes', async () => {
    settings = { ...settings, mode: 'off' };
    const ids = await story();
    const reports = await reportStory(ids);
    expect(relay.stored).toEqual([]);
    settings = { ...settings, mode: 'mirror' };
    const backfillDb = new MysqlE2eeBackfillDb(() => sqlExecutor);
    const blobStores = createE2eeBlobStores({ rows: db, env: () => ({}) });
    const ciphertexts = new MysqlE2eeCiphertextStore(() => sqlExecutor);
    const deps: E2eeBackfillDeps = {
      db: backfillDb,
      writers,
      run: (work) =>
        settledRun(publisher, backfillDb, (connection, batch) =>
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
      backupBytes: 4096,
      reports: 2,
      messageReports: 1,
      reportAccess: 1
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
    expect(verify.failures).toEqual([]);
    expect(verify.coverage).toMatchObject({ missing: 0 });
    expect(verify.ok).toBe(true);
    const before = await answers(ids);
    const reportsBefore = await reportAnswers(reports);
    await emptyTables();
    expect((await rebuild('write')).ok).toBe(true);
    expect(await answers(ids)).toEqual(before);
    expect(await reportAnswers(reports)).toEqual(reportsBefore);
  });
  it('checks stream by stream against MySQL, and names a changed row', async () => {
    const ids = await story();
    const reports = await reportStory(ids);
    const verify = (after?: string) => slice('verify', after);
    const clean = await rebuild('verify');
    expect(clean.failures).toEqual([]);
    // dr for each device, cv, dv, bl, bk and the moderators' inbox.
    expect(clean.streams).toBe(7);
    expect(clean.slices).toBe(4);
    let after: string | undefined;
    await sqlExecutor.execute(
      `update e2ee_log set epoch_fp = 'ffffffffffffffff' where group_handle = :group and seq = 2`,
      { group: ids.group }
    );
    const failures = [];
    after = undefined;
    do {
      const page = await verify(after);
      failures.push(...(page.failures ?? []));
      after = page.next ?? undefined;
    } while (after !== undefined);
    expect(failures.map((f) => f.wave)).toEqual([`cv/${ids.group}`]);
    await sqlExecutor.execute(
      `update e2ee_log set epoch_fp = '0102030405060708' where group_handle = :group and seq = 2`,
      { group: ids.group }
    );
    await sqlExecutor.execute(
      `update e2ee_reports set on_hold = false where id = :id`,
      { id: reports.messageReportId }
    );
    const reportFailures = [];
    after = undefined;
    do {
      const page = await verify(after);
      reportFailures.push(...(page.failures ?? []));
      after = page.next ?? undefined;
    } while (after !== undefined);
    expect(reportFailures).toHaveLength(1);
    expect(reportFailures[0]).toMatchObject({
      wave: expect.stringMatching(/^md\//),
      tables: [{ table: 'e2ee_reports', changed: 1 }]
    });
  });

  it('names an entity with no stream, and writes in slices that resume', async () => {
    settings = { ...settings, mode: 'off' };
    const a = randomE2eeKey().publicKey;
    await addDevice(a, 'pa');
    settings = { ...settings, mode: 'mirror' };
    const ids = await story();
    const coverage = await rebuild('verify');
    expect(coverage.ok).toBe(false);
    expect(coverage.coverage).toMatchObject({ devices: 1, missing: 1 });
    await sqlExecutor.execute(
      `delete from e2ee_devices where device_key = :a`,
      {
        a
      }
    );
    const before = await answers(ids);
    await emptyTables();
    // A clock that runs out after a step or two: every slice stops early
    // and the next one picks up where it stopped.
    let clock = 0;
    const write = await rebuild('write', {
      timeBudgetMs: 2500,
      clock: () => (clock += 1000)
    });
    expect(write.ok).toBe(true);
    expect(write.slices).toBeGreaterThan(5);
    expect(write.streams).toBe(6);
    expect(await answers(ids)).toEqual(before);
    expect((await rebuild('verify')).ok).toBe(true);
  });

  it('records a revocation once, in the device inbox, and rebuilds the rosters', async () => {
    const ids = await story();
    const outboxBefore = relay.stored.length;
    const revokedAt = Math.floor(NOW / 1000);
    await devices.revokeDevice('pb', ids.b, {
      revoker_device_key: ids.b,
      revoked_at: revokedAt,
      signature: ids.bKey.sign(
        e2eeRevokeDigest({
          targetDeviceKey: ids.b,
          revokerDeviceKey: ids.b,
          revokedAtSeconds: revokedAt
        })
      )
    });
    await publisher.settled();
    const added = relay.stored
      .slice(outboxBefore)
      .map((item) => item.event.wave);
    expect(added.sort()).toEqual([`dr/${ids.b}`, `dv/${ids.b}`].sort());
    // A revoked device reads nothing; the others see its closed rows.
    const seen = async () =>
      withoutActivity({
        group: await groups.getGroup('pa', ids.group, ids.a),
        logA: await groups.getLog('pa', ids.group, { device_key: ids.a }),
        devices: await devices.getProfileDevices('pb'),
        rosters: await sqlExecutor.execute(
          `select * from e2ee_group_roster order by id`
        )
      });
    const before = await seen();
    expect((await rebuild('verify')).ok).toBe(true);
    await emptyTables();
    expect((await rebuild('write')).ok).toBe(true);
    expect(await seen()).toEqual(before);
  });

  it('appends from 16 writers to one stream at once without a deadlock', async () => {
    const device = randomE2eeKey().publicKey;
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, (_, n) =>
        settledRun(publisher, db, (connection, batch) =>
          batch!.append(connection, {
            family: 'dv',
            owner: device,
            kind: 10,
            refs: ['welcome'],
            type: 'welcome',
            ops: [
              {
                op: 'put',
                table: 'e2ee_welcome_deliveries',
                row: {
                  welcome_id: `0x${n.toString(16).padStart(32, '0')}`,
                  device_key: device,
                  profile_id: 'pa',
                  created_at: NOW
                }
              }
            ]
          })
        )
      )
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const [head] = await sqlExecutor.execute(
      `select head_pos from e2ee_streams where wave = :wave`,
      { wave: `dv/${device}` }
    );
    expect(Number(head.head_pos)).toBe(16);
    await publisher.publishPending(10);
    expect(
      relay.stored.filter((item) => item.event.wave === `dv/${device}`)
    ).toHaveLength(16);
  });

  it('sends a DEL for an acked Welcome; the relays drop it and the rebuild agrees', async () => {
    const ids = await story();
    const [welcome] = await groups.getWelcomes('pb', ids.b);
    await groups.ackWelcome('pb', ids.b, welcome.id);
    await publisher.settled();
    const queued = await sqlExecutor.execute<{ positions: string }>(
      `select positions from e2ee_relay_deletions where wave = :wave`,
      { wave: `dv/${ids.b}` }
    );
    expect(queued.map((row) => JSON.parse(row.positions))).toEqual([[1]]);
    // With the backup compaction's DEL (the compacted chunk's bytes).
    expect(await publisher.publishDeletions(10)).toEqual({
      queued: 2,
      done: 2
    });
    const [first] = relay.stored.filter(
      (item) => item.event.wave === `dv/${ids.b}`
    );
    // The relay keeps the Welcome's header only.
    expect(first.event.body).toBeNull();
    expect(
      relay.stored.some(
        (item) =>
          item.event.kind === 12 &&
          JSON.parse(item.event.body!).ids.includes(first.event.id)
      )
    ).toBe(true);
    expect(
      await sqlExecutor.execute(`select * from e2ee_relay_deletions`)
    ).toEqual([]);
    const before = await answers(ids);
    expect((await rebuild('verify')).ok).toBe(true);
    await emptyTables();
    expect((await rebuild('write')).ok).toBe(true);
    expect(await answers(ids)).toEqual(before);
  });

  it('names what keeps failing, with the last error; verify calls it lagging', async () => {
    const ids = await story();
    const [welcome] = await groups.getWelcomes('pb', ids.b);
    relay.down = true;
    await groups.ackWelcome('pb', ids.b, welcome.id);
    await publisher.settled();
    await publisher.publishDeletions(10);
    const failing = await store.worstFailures();
    expect(failing.outbox).toEqual({
      wave: `dv/${ids.b}`,
      attempts: 1,
      lastError: expect.stringContaining('wss://relay.test')
    });
    expect(failing.deletion).toMatchObject({
      attempts: 1,
      lastError: expect.stringContaining('wss://relay.test')
    });
    relay.down = false;
    // The ack's record still waits in the outbox: lagging, not different.
    expect(await rebuild('verify')).toMatchObject({
      failures: [],
      laggingStreams: [`dv/${ids.b}`],
      ok: true
    });
    await publisher.publishPending(10);
    await publisher.publishDeletions(10);
    expect(await rebuild('verify')).toMatchObject({
      failures: [],
      laggingStreams: [],
      ok: true
    });
    expect(await store.worstFailures()).toEqual({
      outbox: null,
      deletion: null
    });
  });
});
