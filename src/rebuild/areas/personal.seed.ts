import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  randomUUID
} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { id as labelHash, Wallet } from 'ethers';
import {
  APP_DEVICE_GRANT_DOMAIN_V2,
  APP_DEVICE_GRANT_TYPES_V2,
  AppDeviceGrant,
  buildAppDeviceGrantMessage,
  computeAppDeviceGrantId,
  serializeAppDeviceGrantMessage
} from '@/api/device-signing/app-device-grant';
import { CURRENT_EULA_VERSION } from '@/api/policies/eula-policy';
import {
  ADDRESS_CONSOLIDATION_KEY,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  IDENTITIES_TABLE,
  PROFILES_TABLE,
  WAVES_TABLE
} from '@/constants';
import { DropType } from '@/entities/IDrop';
import type { RebuildContext } from '@/rebuild/manifest.types';
import { PROBE_WALLETS } from '@/rebuild/manifests/probe-fixture';
import { probeProfileId } from '@/rebuild/run/probe-fixture.steps';
import { RequestContext } from '@/request.context';
import {
  RecordGrantProof,
  signRecordEvent
} from '@/signed-records/record-event';
import { verifyGrantProof } from '@/signed-records/record-grant-proofs';
import { RecordRegistry } from '@/signed-records/record-index';
import { RecordKind } from '@/signed-records/record-kinds';
import { recordLog } from '@/signed-records/record-log/record-log';
import { recordLogDb } from '@/signed-records/record-log/record-log.db';
import {
  RecordLogSegmenter,
  RecordLogWriter
} from '@/signed-records/record-log/record-log.service';
import { LocalRecordsWaveReader } from '@/signed-records/record-log/records-wave-local-reader';
import { loadProviderKeys, ProviderKey } from '@/signed-records/sealed-crypto';
import { signedRecordHeadsDb } from '@/signed-records/signed-record-heads.db';
import { readRecordsWaveSetting } from '@/waves-scope/waves-scope';
import { dbSupplier } from '@/sql-executor';
import { aWave } from '@/tests/fixtures/wave.fixture';
import {
  isImportDone,
  PERSONAL_IMPORT_LANE,
  PersonalImportBody,
  PersonalImportBuilder,
  PersonalImportDone,
  personalExportDb
} from '@/personal-records/personal-import';
import { checkPersonalItem } from '@/personal-records/personal-record-checks';
import {
  mentionAliasId,
  PersonalRecordType,
  registerPersonalRecordTypes
} from '@/personal-records/personal-record-types';
import type { PersonalLiveEffects } from '@/personal-records/personal-records.ports';
import { PersonalRecordsService } from '@/personal-records/personal-records.service';
import { personalRecordsStateDb } from '@/personal-records/personal-records-state.db';
import {
  personalLiveEffects,
  personalTables
} from '@/personal-records/personal-records.wiring';
import { recordOwnerDirectory } from '@/personal-records/record-owner-directory';

/**
 * The personal area's seed for the rebuild check. Before the drop it sets
 * up what the rebuild of the personal settings reads, through the same
 * paths production uses at the switch:
 * 1. the waves and drops the settings name, and the records wave (plain
 *    rows, as the other seeds write waves: waves has no rebuilder yet);
 * 2. the probe caller's settings, through today's db calls, at fixed times;
 * 3. the switch: freeze, the one-time import into the record log;
 * 4. settings open again, and a setting changed live through the records
 *    service in primary, as POST /signed-records applies one;
 * 5. a closed segment, its file in the run's seed files, and its head drop
 *    in the records wave posted as the records service.
 * The rebuild then gets every row back from the import and the live
 * record, not from these, and the live record's heads with them.
 */

/** The wave and drop the probes name (personal.manifest.ts). */
export const PERSONAL_PROBE_WAVE = '00000000-0000-4000-8000-000000000001';
export const PERSONAL_PROBE_DROP = '00000000-0000-4000-8000-000000000002';
// Its own device id: another area's seed has devices of its own.
export const PERSONAL_PROBE_DEVICE = 'rebuild-check-settings-device';
// Each wave's description drop, as wave creation makes one.
const PROBE_WAVE_DESCRIPTION = '00000000-0000-4000-8000-000000000003';
const RECORDS_WAVE_DESCRIPTION = '00000000-0000-4000-8000-0000000000a2';

// Fixed, so a second pass minutes later answers the same.
const SEEDED_AT = 1_767_225_600_000;
const IMPORT_ANCHOR = 1;

// The live record's profile, and its order after the import's.
const LIVE_PROFILE = '00000000-0000-4000-8000-0000000000b1';
const LIVE_HANDLE = 'rebuild-live';
const LIVE_ANCHOR = IMPORT_ANCHOR + 1;
const LIVE_AT = SEEDED_AT + 60_000;
const ED25519_PKCS8_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex'
);

async function insertRow(
  table: string,
  row: Record<string, unknown>
): Promise<void> {
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
        value !== null && typeof value === 'object'
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

async function insertWave(
  id: string,
  createdBy: string,
  descriptionDropId: string
): Promise<void> {
  const { serial_no: _serial, ...wave } = aWave(
    {
      is_direct_message: false,
      created_by: createdBy,
      created_at: SEEDED_AT,
      description_drop_id: descriptionDropId
    },
    { id, name: id }
  );
  await insertRow(WAVES_TABLE, wave);
  await insertDrop({
    id: descriptionDropId,
    waveId: id,
    authorId: createdBy,
    createdAt: SEEDED_AT,
    content: 'A wave for the rebuild check.'
  });
}

async function insertDrop(drop: {
  readonly id: string;
  readonly waveId: string;
  readonly authorId: string;
  readonly createdAt: number;
  readonly content: string;
}): Promise<void> {
  await insertRow(DROPS_TABLE, {
    id: drop.id,
    wave_id: drop.waveId,
    author_id: drop.authorId,
    created_at: drop.createdAt,
    updated_at: null,
    title: null,
    parts_count: 1,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    drop_type: DropType.CHAT,
    signature: null,
    hide_link_preview: true
  });
  await insertRow(DROPS_PARTS_TABLE, {
    drop_id: drop.id,
    drop_part_id: 1,
    content: drop.content,
    quoted_drop_id: null,
    quoted_drop_part_id: null,
    wave_id: drop.waveId
  });
}

/** An identity of one wallet, as the identity seed writes its own. */
async function insertIdentity(
  profileId: string,
  wallet: string,
  // At most 15 characters.
  handle: string
): Promise<void> {
  await dbSupplier().execute(
    `insert ignore into ${IDENTITIES_TABLE}
       (consolidation_key, profile_id, primary_address, handle,
        normalised_handle, tdh, rep, cic, level_raw, classification,
        xtdh, produced_xtdh, granted_xtdh, xtdh_rate, basetdh_rate)
     values (:wallet, :profileId, :wallet, :handle, :handle,
        0, 0, 0, 0, 'PSEUDONYM', 0, 0, 0, 0, 0)`,
    { wallet, profileId, handle }
  );
  await dbSupplier().execute(
    `insert ignore into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
     values (:wallet, :wallet)`,
    { wallet }
  );
}

/**
 * A profiles row for each profile a setting names: today's block checks
 * the profiles table, which the identity seed doesn't write.
 */
async function insertProfile(
  profileId: string,
  handle: string,
  wallet: string
): Promise<void> {
  await dbSupplier().execute(
    `insert ignore into ${PROFILES_TABLE}
       (external_id, handle, normalised_handle, primary_wallet, created_at,
        created_by_wallet, classification)
     values (:profileId, :handle, :handle, :wallet, :createdAt, :wallet,
        'PSEUDONYM')`,
    { profileId, handle, wallet, createdAt: new Date(SEEDED_AT) }
  );
}

/** The probe caller's settings, as today's routes write them. */
async function seedSettings(
  me: string,
  other: string,
  // The records service: muted and blocked, so the probe caller's mute and
  // block don't touch the other probe profile, whose follows and
  // notifications the other areas' seeds write.
  quiet: string,
  ctx: RequestContext
): Promise<void> {
  const t = personalTables;
  const follow = (
    subscriberId: string,
    targetType: 'IDENTITY' | 'WAVE' | 'DROP',
    targetId: string,
    actions: ('DROP_CREATED' | 'WAVE_CREATED' | 'DROP_REPLIED')[],
    waveId: string | null
  ) =>
    Promise.all(
      actions.map((action) =>
        t.addFollow(
          { subscriberId, targetType, targetId, action, waveId },
          ctx,
          false
        )
      )
    );
  const everything: ('DROP_CREATED' | 'WAVE_CREATED' | 'DROP_REPLIED')[] = [
    'WAVE_CREATED',
    'DROP_CREATED',
    'DROP_REPLIED'
  ];
  await follow(me, 'IDENTITY', other, everything, null);
  await follow(other, 'IDENTITY', me, everything, null);
  await follow(
    me,
    'WAVE',
    PERSONAL_PROBE_WAVE,
    ['DROP_CREATED'],
    PERSONAL_PROBE_WAVE
  );
  await follow(
    me,
    'DROP',
    PERSONAL_PROBE_DROP,
    ['DROP_REPLIED'],
    PERSONAL_PROBE_WAVE
  );
  await t.replaceWaveGroups(me, PERSONAL_PROBE_WAVE, ['ALL'], ctx);
  await t.setWaveAllDrops(me, PERSONAL_PROBE_WAVE, true, ctx);
  await t.setMuted(me, quiet, true, SEEDED_AT, ctx);
  await t.setBlocked(me, quiet, true, SEEDED_AT, ctx, false);
  await t.setArtworkAlert(me, other, true, SEEDED_AT, ctx);
  await t.setArtworkAlert(other, me, true, SEEDED_AT, ctx);
  await t.updatePreferences(
    me,
    { direct_message_policy: 'PEOPLE_I_FOLLOW' },
    ctx
  );
  await t.putAlias(
    {
      id: mentionAliasId(me, 'probe_friends'),
      ownerId: me,
      alias: 'probe_friends',
      memberIds: [other],
      exists: false
    },
    ctx
  );
  await t.setPin(me, PERSONAL_PROBE_WAVE, 1, ctx);
  await t.setBookmarked(me, PERSONAL_PROBE_DROP, true, SEEDED_AT, ctx);
  await t.setPushSettings(
    me,
    PERSONAL_PROBE_DEVICE,
    {
      identity_subscribed: true,
      identity_mentioned: true,
      identity_rep: false,
      identity_nic: false,
      drop_quoted: true,
      drop_replied: true,
      drop_voted: false,
      drop_reacted: false,
      drop_boosted: true,
      wave_created: true,
      subscription_coverage: false
    },
    ctx
  );
  await t.setEulaConsent(
    me,
    PERSONAL_PROBE_DEVICE,
    { version: CURRENT_EULA_VERSION, platform: 'ios' },
    SEEDED_AT,
    ctx
  );
}

/**
 * The live record's signer: a wallet and a device key made from fixed
 * labels, so every run signs the same record and no key is stored. The
 * wallet is bound to no principal (the run has no chain gateway), so its
 * stream is a public one: ps.
 */
function liveSigner(): {
  wallet: Wallet;
  deviceKey: KeyObject;
  devicePublicKey: string;
} {
  const wallet = new Wallet(
    labelHash('rebuild-check personal seed: live record wallet')
  );
  const deviceKey = createPrivateKey({
    key: Buffer.concat([
      ED25519_PKCS8_PREFIX,
      createHash('sha256')
        .update('rebuild-check personal seed: live record device')
        .digest()
    ]),
    format: 'der',
    type: 'pkcs8'
  });
  const spki = createPublicKey(deviceKey).export({
    format: 'der',
    type: 'spki'
  });
  return {
    wallet,
    deviceKey,
    devicePublicKey: `0x${spki.subarray(-32).toString('hex')}`
  };
}

/** The wallet's app grant for the device, as the app signs one. */
async function liveGrant(
  wallet: Wallet,
  deviceKey: string
): Promise<RecordGrantProof> {
  const grant: AppDeviceGrant = {
    version: 2,
    wallet: wallet.address.toLowerCase(),
    device_key: deviceKey,
    scopes: ['post', 'edit', 'delete', 'react'],
    mls_device_key: null,
    ciphersuite: null,
    ciphersuites: [],
    issued_at: SEEDED_AT / 1000 - 3600,
    expires_at: SEEDED_AT / 1000 + 30 * 86_400,
    origin: 'rebuild check'
  };
  const message = buildAppDeviceGrantMessage(grant);
  const signature = await wallet.signTypedData(
    APP_DEVICE_GRANT_DOMAIN_V2,
    APP_DEVICE_GRANT_TYPES_V2,
    message
  );
  return {
    id: computeAppDeviceGrantId(message),
    message: serializeAppDeviceGrantMessage(message),
    wallet_signature: signature.toLowerCase(),
    chain_id: 1,
    wallet: grant.wallet,
    device_key: grant.device_key,
    scopes: [...grant.scopes],
    domain: grant.origin,
    expires_at: grant.expires_at * 1000,
    revoked_at: null
  };
}

/**
 * The records service as POST /signed-records runs it, with the seed's
 * grant and a fixed anchor and clock. Reads as live reads; the run has no
 * sockets, notifications or activity counters to update, and a rebuild
 * runs none of them either.
 */
const SEED_LIVE_EFFECTS: PersonalLiveEffects = {
  ...personalLiveEffects,
  notifyNewFollower: async () => undefined,
  wavesChanged: async () => undefined,
  recordActiveIdentity: async () => undefined,
  waveFollowChanged: async () => undefined,
  muteChanged: async () => undefined
};

/**
 * After the import, a live setting through the records service in
 * primary: a public follow of the probe caller. It leaves the record heads
 * a rebuild puts back: the follow's own (ps, follow) and its owner's order
 * mark (pv, ~owner). A private setting or a keys record needs its wallet
 * bound to a principal, which the run can't resolve until the chain
 * gateway is wired in.
 */
async function applyLiveRecord(
  followed: string,
  providers: readonly ProviderKey[]
): Promise<void> {
  const { wallet, deviceKey, devicePublicKey } = liveSigner();
  const owner = wallet.address.toLowerCase();
  await insertIdentity(LIVE_PROFILE, owner, LIVE_HANDLE);
  await insertProfile(LIVE_PROFILE, LIVE_HANDLE, owner);
  const proof = await liveGrant(wallet, devicePublicKey);
  const verified = verifyGrantProof(proof);
  if (!verified.ok) {
    throw new Error(
      `The personal seed's grant is not valid: ${verified.reason}`
    );
  }
  const owners = recordOwnerDirectory;
  const service = new PersonalRecordsService({
    grants: {
      findGrant: async (grantId) =>
        grantId === verified.grant.id ? verified.grant : null
    },
    owners,
    anchors: {
      getAnchor: async () => ({
        anchor: LIVE_ANCHOR,
        headHeight: LIVE_ANCHOR,
        finalizedTime: LIVE_AT,
        maxAnchorLag: 120
      })
    },
    heads: signedRecordHeadsDb,
    registry: registerPersonalRecordTypes(new RecordRegistry(), {
      owners,
      tables: personalTables,
      live: SEED_LIVE_EFFECTS
    }),
    providers: () => providers,
    log: new RecordLogWriter(recordLogDb, {
      findGrantProofs: async (ids) => (ids.includes(proof.id) ? [proof] : [])
    }),
    importOrder: async () => (await personalRecordsStateDb.read()).importOrder,
    now: () => LIVE_AT,
    maxClockSkewMs: 60_000
  });
  const follow = signRecordEvent(
    {
      kind: RecordKind.RECORD,
      wave: `ps/${owner}`,
      refs: [PersonalRecordType.FOLLOW, `identity:${followed}`],
      body: { actions: ['DROP_CREATED'] },
      author: owner,
      deviceKey: devicePublicKey,
      authRef: proof.id,
      seq: LIVE_AT,
      anchor: LIVE_ANCHOR,
      claimedTime: LIVE_AT
    },
    deviceKey
  );
  const results = await service.submit([follow], 'primary', LIVE_PROFILE, {});
  if (results.some((result) => result.outcome !== 'applied')) {
    throw new Error(
      `The personal seed's live record was not applied: ${JSON.stringify(results)}`
    );
  }
}

/** Writes a file into the run's seed files and lists it in files.json. */
function seedFile(dir: string, bytes: Buffer): string {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const id = `f${sha256}`;
  fs.writeFileSync(path.join(dir, id), bytes);
  const index = path.join(dir, 'files.json');
  const listed: Record<string, string> = fs.existsSync(index)
    ? JSON.parse(fs.readFileSync(index, 'utf8'))
    : {};
  listed[id] = sha256;
  fs.writeFileSync(index, `${JSON.stringify(listed, null, 2)}\n`);
  return id;
}

/** The one-time import of what was just seeded, as runPersonalImport does it. */
async function importSettings(): Promise<void> {
  const builder = new PersonalImportBuilder({
    anchor: IMPORT_ANCHOR,
    at: SEEDED_AT,
    ownersOf: async (profileIds) => {
      const rows = await dbSupplier().execute<{
        profile_id: string;
        primary_address: string;
      }>(
        `select profile_id, primary_address from ${IDENTITIES_TABLE}
         where profile_id in (:profileIds)`,
        { profileIds: [...profileIds] }
      );
      const byWallet = await recordOwnerDirectory.ownersAt(
        rows.map((row) => row.primary_address.toLowerCase()),
        IMPORT_ANCHOR
      );
      const owners = new Map<string, string>();
      for (const row of rows) {
        const owner = byWallet.get(row.primary_address.toLowerCase());
        if (owner) owners.set(row.profile_id, owner);
      }
      return owners;
    },
    check: checkPersonalItem,
    emit: (entries) =>
      recordLogDb.executeNativeQueriesInTransaction(async (connection) => {
        await recordLog.append(entries, { connection });
        const closing = entries.some(
          (entry) =>
            entry.t === 'entry' &&
            entry.lane === PERSONAL_IMPORT_LANE &&
            isImportDone(
              entry.body as unknown as PersonalImportBody | PersonalImportDone
            )
        );
        if (closing) {
          await personalRecordsStateDb.setImport(IMPORT_ANCHOR, SEEDED_AT, {
            connection
          });
        }
      })
  });
  for await (const ids of personalExportDb.ownerPages()) {
    await builder.addPage(await personalExportDb.readPage(ids));
  }
  await builder.finish();
}

export async function seedPersonalSettings(
  ctx: RebuildContext,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<void> {
  const dir = ctx.seedFilesDir;
  if (!dir) {
    throw new Error(
      'The personal seed writes a segment file: the run has no files source'
    );
  }
  // The records wave as the record log and the rebuild read it.
  const records = readRecordsWaveSetting(env);
  if (records.kind !== 'id') {
    throw new Error("The personal seed's records wave: no records wave set");
  }
  const waveId = records.id;
  const serviceProfileId = env.SIGNED_RECORDS_SERVICE_PROFILE_ID;
  const serviceWallet = env.SIGNED_RECORDS_SERVICE_WALLET?.toLowerCase();
  const providers = loadProviderKeys(env.SIGNED_RECORDS_PROVIDER_KEYS);
  if (!serviceProfileId || !serviceWallet || !providers.length) {
    throw new Error("The personal seed needs the area's records flags");
  }
  const me = probeProfileId(1);
  const other = probeProfileId(PROBE_WALLETS.length);

  await insertIdentity(serviceProfileId, serviceWallet, 'rebuild-records');
  await insertProfile(serviceProfileId, 'rebuild-records', serviceWallet);
  for (let index = 0; index < PROBE_WALLETS.length; index++) {
    const profileId = probeProfileId(index + 1);
    await insertProfile(profileId, profileId, PROBE_WALLETS[index]);
  }
  await insertWave(PERSONAL_PROBE_WAVE, other, PROBE_WAVE_DESCRIPTION);
  await insertDrop({
    id: PERSONAL_PROBE_DROP,
    waveId: PERSONAL_PROBE_WAVE,
    authorId: other,
    createdAt: SEEDED_AT,
    content: 'A drop the probe caller follows and bookmarks.'
  });
  await insertWave(waveId, serviceProfileId, RECORDS_WAVE_DESCRIPTION);

  await dbSupplier().executeNativeQueriesInTransaction((connection) =>
    seedSettings(me, other, serviceProfileId, { connection })
  );

  await personalRecordsStateDb.setFrozen(true);
  try {
    await importSettings();
  } finally {
    await personalRecordsStateDb.setFrozen(false);
  }
  await applyLiveRecord(PROBE_WALLETS[0], providers);
  const segmenter = new RecordLogSegmenter({
    store: recordLogDb,
    providers,
    pinner: {
      pin: async (bytes) => seedFile(dir, bytes),
      fetch: async (cid) => fs.readFileSync(path.join(dir, cid))
    },
    archiver: {
      upload: () => {
        throw new Error('The seed archives nothing');
      }
    },
    poster: {
      post: async (text) => {
        const id = randomUUID();
        await insertDrop({
          id,
          waveId,
          authorId: serviceProfileId,
          createdAt: Date.now(),
          content: text
        });
        // As drop creation does: the author follows their own drop.
        await dbSupplier().executeNativeQueriesInTransaction((connection) =>
          personalTables.addFollow(
            {
              subscriberId: serviceProfileId,
              targetType: 'DROP',
              targetId: id,
              action: 'DROP_REPLIED',
              waveId
            },
            { connection },
            false
          )
        );
        return id;
      }
    },
    wave: new LocalRecordsWaveReader({
      waveId,
      profileId: serviceProfileId,
      wallet: serviceWallet
    }),
    serviceWallets: [serviceWallet]
  });
  const heads = await segmenter.closeSegments({});
  if (!heads.length) {
    throw new Error('The personal seed closed no segment');
  }
}
