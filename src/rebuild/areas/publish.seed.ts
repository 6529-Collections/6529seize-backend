import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ADDRESS_CONSOLIDATION_KEY,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  IDENTITIES_TABLE,
  PROFILES_TABLE,
  SIGNED_RECORD_LOG_ENTRIES_TABLE,
  WAVES_TABLE
} from '@/constants';
import { identitySubscriptionsDb } from '@/api/identity-subscriptions/identity-subscriptions.db';
import { dropsDb } from '@/drops/drops.db';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import { DropType } from '@/entities/IDrop';
import { ProfileCmsPackageStatus } from '@/entities/IProfileCmsPackage';
import { ProfileCmsPointerEventType } from '@/entities/IProfileCmsPointerEvent';
import { profileCmsAgentGrantsDb } from '@/profile-cms/profile-cms-agent-grants.db';
import {
  NewProfileCmsPackageEntity,
  profileCmsPackagesDb
} from '@/profile-cms/profile-cms-packages.db';
import { profileCmsPointerEventsDb } from '@/profile-cms/profile-cms-pointer-events.db';
import { PROFILE_CMS_LOG_LANE } from '@/profile-cms/personal-log/profile-cms-private-log';
import { profileCmsPublishSignaturesDb } from '@/profile-cms/profile-cms-publish-signatures.db';
import type { RebuildContext } from '@/rebuild/manifest.types';
import { PROBE_WALLETS } from '@/rebuild/manifests/probe-fixture';
import { RequestContext } from '@/request.context';
import { recordLogDb } from '@/signed-records/record-log/record-log.db';
import { RecordLogSegmenter } from '@/signed-records/record-log/record-log.service';
import { LocalRecordsWaveReader } from '@/signed-records/record-log/records-wave-local-reader';
import { loadProviderKeys } from '@/signed-records/sealed-crypto';
import { dbSupplier } from '@/sql-executor';
import {
  PUBLISH_SEED_IDS,
  PublishSeedProfile,
  publishSeedSites
} from '@/rebuild/areas/publish.fixture';
import { probeProfileId } from '@/rebuild/run/probe-fixture.steps';
import { SignedSiteFixture } from '@/tests/fixtures/profile-cms-chain.fixture';
import { aWave } from '@/tests/fixtures/wave.fixture';

/**
 * The publish area's seed for the rebuild check, with
 * FEATURE_PROFILE_CMS_CHAIN_POINTER off (the shipping default) and the
 * private record log on. Through the profile site tables' own write
 * paths, each of which logs the row it wrote, the first probe profile:
 * 1. publishes a site, as the old publish path writes it: the draft, the
 *    consumed publish signature, the package marked published and primary,
 *    and its PUBLISH and SET_PRIMARY pointer events;
 * 2. keeps a second draft;
 * 3. issues an agent grant on that draft, with its event.
 * Then it closes its own open entries of the record log (it refuses if
 * another area's are open) into a segment, puts the
 * segment file in the run's seed files and posts its head to the records
 * wave, as the records service. The rebuild gets every row back from the
 * log, not from these tables.
 *
 * The first probe profile is the identity seed's: this seed reads it by
 * its wallet and writes no profile, identity or wallet row for it.
 *
 * The records service (its identity, profile and wave) is the fixture the
 * personal area's seed uses, with the same SIGNED_RECORDS_* values; it is
 * written only where missing, so either seed may run first, or alone.
 */

// Fixed, so a second pass minutes later answers the same.
const SEEDED_AT = 1_767_225_600_000;

const ctx: RequestContext = {};

function draftRow(
  site: SignedSiteFixture,
  profile: PublishSeedProfile,
  version: number,
  createdAt: number
): NewProfileCmsPackageEntity {
  const receipt = site.cmsPackage.storage[0];
  return {
    id: site.draftId,
    profile_id: profile.id,
    profile_handle: profile.handle,
    package_id: site.cmsPackage.package_id,
    version,
    status: ProfileCmsPackageStatus.DRAFT,
    cms_package: site.cmsPackage,
    payload_hash: site.cmsPackage.integrity.payload_hash,
    package_hash: site.packageHash,
    primary_path: `/${profile.handle}/index.html`,
    is_primary: false,
    production_valid: false,
    created_by_profile_id: profile.id,
    published_by_profile_id: null,
    created_at: createdAt,
    updated_at: createdAt,
    superseded_by_id: null,
    validation_result: null,
    validation_error: null,
    storage_receipts: site.cmsPackage.storage,
    storage_provider: receipt.provider,
    storage_uri: receipt.uri,
    storage_content_hash: receipt.content_hash,
    storage_provider_content_id: null,
    storage_recorded_at: receipt.recorded_at,
    storage_pinned: null,
    storage_canonical: true
  };
}

/** The old publish path's writes for `site`, at `at`. */
async function publishOnTheOldPath(
  site: SignedSiteFixture,
  profile: PublishSeedProfile,
  at: number
): Promise<void> {
  const signature = site.cmsPackage.signatures[0];
  const signer = signature.signer.toLowerCase();
  await profileCmsPublishSignaturesDb.insertConsumed(
    {
      id: `${site.draftId}-signature`,
      typed_data_hash: site.typedDataHash,
      profile_id: profile.id,
      package_db_id: site.draftId,
      package_id: site.cmsPackage.package_id,
      package_version: 1,
      package_hash: site.packageHash,
      signer_address: signer,
      deadline: 1_790_000_000_000,
      created_at: at
    },
    ctx
  );
  await profileCmsPackagesDb.markValidating(site.draftId, at, ctx);
  await profileCmsPackagesDb.supersedePrimaryForProfile(
    profile.id,
    site.draftId,
    at,
    ctx
  );
  await profileCmsPackagesDb.markPublished(
    site.draftId,
    profile.id,
    { valid: true },
    at,
    ctx
  );
  const event = (type: ProfileCmsPointerEventType, sequence: number) => ({
    id: `${site.draftId}-${type.toLowerCase()}`,
    event_type: type,
    profile_id: profile.id,
    profile_handle: profile.handle,
    package_db_id: site.draftId,
    package_id: site.cmsPackage.package_id,
    package_version: 1,
    package_hash: site.packageHash,
    payload_hash: site.cmsPackage.integrity.payload_hash,
    previous_package_db_id: null,
    actor_profile_id: profile.id,
    signer_address: signer,
    signature: signature.signature,
    typed_data: signature.domain,
    typed_data_hash: site.typedDataHash,
    storage_receipt: site.cmsPackage.storage[0],
    event_sequence: sequence,
    created_at: at
  });
  await profileCmsPointerEventsDb.insert(
    event(ProfileCmsPointerEventType.PUBLISH, 0),
    ctx
  );
  await profileCmsPointerEventsDb.insert(
    event(ProfileCmsPointerEventType.SET_PRIMARY, 1),
    ctx
  );
}

async function issueAgentGrant(
  site: SignedSiteFixture,
  candidate: SignedSiteFixture,
  profile: PublishSeedProfile,
  at: number
): Promise<void> {
  await profileCmsAgentGrantsDb.insertGrant(
    {
      id: PUBLISH_SEED_IDS.grant,
      profile_id: profile.id,
      draft_id: site.draftId,
      package_id: site.cmsPackage.package_id,
      base_version: 2,
      base_package_hash: site.packageHash,
      issued_by_wallet: PROBE_WALLETS[0],
      token_hash: createHash('sha256')
        .update('6529 rebuild check: fixture agent token, never a real one')
        .digest('hex'),
      label: 'Rebuild check agent',
      created_at: at,
      expires_at: at + 365 * 24 * 60 * 60 * 1000,
      revoked_at: null,
      request_count: 0,
      proposal_count: 0
    },
    ctx
  );
  await profileCmsAgentGrantsDb.insertEvent(
    {
      id: `${PUBLISH_SEED_IDS.grant}-issued`,
      profile_id: profile.id,
      grant_id: PUBLISH_SEED_IDS.grant,
      proposal_id: null,
      event_type: 'issued',
      actor_wallet: PROBE_WALLETS[0],
      created_at: at
    },
    ctx
  );
  await profileCmsAgentGrantsDb.insertProposal(
    {
      id: PUBLISH_SEED_IDS.proposal,
      grant_id: PUBLISH_SEED_IDS.grant,
      profile_id: profile.id,
      draft_id: site.draftId,
      base_version: 2,
      base_package_hash: site.packageHash,
      candidate_package_hash: candidate.packageHash,
      idempotency_key: '00000000-0000-4000-8000-0000000000c1',
      request_hash: `sha256:${createHash('sha256')
        .update('6529 rebuild check: fixture agent request')
        .digest('hex')}`,
      summary: 'A title change',
      created_at: at + 60_000,
      candidate_package: candidate.cmsPackage,
      status: 'pending',
      reviewed_at: null,
      result_draft_id: null,
      result_package_hash: null
    },
    ctx
  );
}

/** `insert ignore` with the row's columns the table has. */
async function insertIgnore(
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
 * The records service of the run, where missing: its identity and profile
 * (handle `rebuild-records`) and its records wave.
 */
async function ensureRecordsService(service: {
  readonly profileId: string;
  readonly wallet: string;
  readonly waveId: string;
}): Promise<void> {
  await insertIgnore(IDENTITIES_TABLE, {
    consolidation_key: service.wallet,
    profile_id: service.profileId,
    primary_address: service.wallet,
    handle: 'rebuild-records',
    normalised_handle: 'rebuild-records',
    tdh: 0,
    rep: 0,
    cic: 0,
    level_raw: 0,
    classification: 'PSEUDONYM',
    xtdh: 0,
    produced_xtdh: 0,
    granted_xtdh: 0,
    xtdh_rate: 0,
    basetdh_rate: 0
  });
  await insertIgnore(ADDRESS_CONSOLIDATION_KEY, {
    address: service.wallet,
    consolidation_key: service.wallet
  });
  await insertIgnore(PROFILES_TABLE, {
    external_id: service.profileId,
    handle: 'rebuild-records',
    normalised_handle: 'rebuild-records',
    primary_wallet: service.wallet,
    created_at: new Date(SEEDED_AT),
    created_by_wallet: service.wallet,
    classification: 'PSEUDONYM'
  });
  const { serial_no: _serial, ...wave } = aWave(
    {
      is_direct_message: false,
      created_by: service.profileId,
      created_at: SEEDED_AT
    },
    { id: service.waveId, name: service.waveId }
  );
  await insertIgnore(WAVES_TABLE, wave);
}

/**
 * The site's profile: the first probe profile, which the identity seed
 * writes, with the handle of its profiles row.
 */
async function firstProbeProfile(): Promise<PublishSeedProfile> {
  const id = probeProfileId(1);
  const row = await dbSupplier().oneOrNull<{ handle: string | null }>(
    `select handle from ${PROFILES_TABLE} where external_id = :id`,
    { id }
  );
  if (!row?.handle) {
    throw new Error(`The first probe profile, ${id}, has no handle`);
  }
  return { id, handle: row.handle };
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

/**
 * Refuses to close another area's entries: a seed seals only the entries
 * it wrote, so each area's segments hold what its own seed logged.
 */
async function assertOnlyPublishEntriesOpen(): Promise<void> {
  const lanes = await dbSupplier().execute<{ lane: string }>(
    `select distinct lane from ${SIGNED_RECORD_LOG_ENTRIES_TABLE}
     where segment_seq is null`
  );
  const others = lanes
    .map((row) => row.lane)
    .filter((lane) => lane !== PROFILE_CMS_LOG_LANE);
  if (others.length) {
    throw new Error(
      `The record log has open entries of other lanes (${others.join(', ')}); the publish seed closes only its own`
    );
  }
}

/**
 * The wave and dropper metrics of a drop the seed wrote, as 6529.io's drop
 * creation applies them: its metrics delta alone, called with the clock
 * held at the drop's created_at so latest_drop_timestamp is that time.
 */
async function applyCreatedDropMetrics(
  drop: { wave_id: string; author_id: string; drop_type: DropType },
  createdAt: number
): Promise<void> {
  const realNow = Date.now;
  Date.now = () => createdAt;
  try {
    await dropsDb.applyInsertedDropMetricsDelta(drop, {});
  } finally {
    Date.now = realNow;
  }
}

/**
 * Closes this seed's open entries into segments, their files in the seed
 * files and their heads posted to the records wave.
 */
async function closeOpenEntries(
  dir: string,
  service: {
    readonly profileId: string;
    readonly wallet: string;
    readonly waveId: string;
  },
  providers: ReturnType<typeof loadProviderKeys>
): Promise<number> {
  const segmenter = new RecordLogSegmenter({
    store: recordLogDb,
    providers,
    pinner: {
      pin: async (bytes) => seedFile(dir, bytes),
      fetch: async (cid) => fs.readFileSync(path.join(dir, cid))
    },
    archiver: {
      upload: () => {
        throw new Error('The publish seed archives nothing');
      }
    },
    poster: {
      post: async (text) => {
        const id = randomUUID();
        const createdAt = Date.now();
        // One description of the drop for its row and its metrics.
        const drop = {
          wave_id: service.waveId,
          author_id: service.profileId,
          drop_type: DropType.CHAT
        };
        await insertIgnore(DROPS_TABLE, {
          id,
          ...drop,
          created_at: createdAt,
          updated_at: null,
          title: null,
          parts_count: 1,
          reply_to_drop_id: null,
          reply_to_part_id: null,
          signature: null,
          hide_link_preview: true
        });
        await insertIgnore(DROPS_PARTS_TABLE, {
          drop_id: id,
          drop_part_id: 1,
          content: text,
          quoted_drop_id: null,
          quoted_drop_part_id: null,
          wave_id: service.waveId
        });
        // As drop creation does: the author follows their own drop.
        await dbSupplier().executeNativeQueriesInTransaction((connection) =>
          identitySubscriptionsDb.addIdentitySubscription(
            {
              subscriber_id: service.profileId,
              target_id: id,
              target_type: ActivityEventTargetType.DROP,
              target_action: ActivityEventAction.DROP_REPLIED,
              wave_id: service.waveId,
              subscribed_to_all_drops: false
            },
            connection
          )
        );
        await applyCreatedDropMetrics(drop, createdAt);
        return id;
      }
    },
    wave: new LocalRecordsWaveReader(service),
    serviceWallets: [service.wallet]
  });
  await assertOnlyPublishEntriesOpen();
  const closed = (await segmenter.closeSegments({})).length;
  // The records service logs a head it could not post and goes on. The
  // seed fails instead, so a missing drop or metrics row can't pass unseen.
  const headless = await recordLogDb.findSegmentsWithoutHead({});
  if (headless.length) {
    throw new Error(
      `The publish seed could not post the head of ${headless
        .map((segment) => `${segment.chain} segment ${segment.seq}`)
        .join(', ')}`
    );
  }
  return closed;
}

export async function seedProfileSites(
  rebuild: RebuildContext,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<void> {
  const dir = rebuild.seedFilesDir;
  if (!dir) {
    throw new Error(
      'The publish seed writes a segment file: the run has no files source'
    );
  }
  const waveId = env.SIGNED_RECORDS_WAVE_ID;
  const profileId = env.SIGNED_RECORDS_SERVICE_PROFILE_ID;
  const wallet = env.SIGNED_RECORDS_SERVICE_WALLET?.toLowerCase();
  const providers = loadProviderKeys(env.SIGNED_RECORDS_PROVIDER_KEYS);
  if (!waveId || !profileId || !wallet || !providers.length) {
    throw new Error("The publish seed needs the area's records flags");
  }
  const service = { profileId, wallet, waveId };
  await ensureRecordsService(service);
  const profile = await firstProbeProfile();

  const { published, draft, candidate } = publishSeedSites(profile);
  await profileCmsPackagesDb.insert(
    draftRow(published, profile, 1, SEEDED_AT),
    ctx
  );
  await publishOnTheOldPath(published, profile, SEEDED_AT + 60_000);
  await profileCmsPackagesDb.insert(
    draftRow(draft, profile, 2, SEEDED_AT + 120_000),
    ctx
  );
  await issueAgentGrant(draft, candidate, profile, SEEDED_AT + 180_000);

  if ((await closeOpenEntries(dir, service, providers)) === 0) {
    throw new Error('The publish seed closed no segment');
  }
}
