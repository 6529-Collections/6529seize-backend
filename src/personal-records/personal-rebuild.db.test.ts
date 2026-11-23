import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  ARTIST_ARTWORK_ALERTS_TABLE,
  CONTENT_MODERATION_AUDIT_LOG_TABLE,
  CONTENT_MODERATION_HIDDEN_DROPS_TABLE,
  CONTENT_MODERATION_PROFILE_BLOCKS_TABLE,
  DROP_BOOKMARKS_TABLE,
  DROPS_TABLE,
  EULA_CONSENT_TABLE,
  IDENTITY_MUTES_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  MENTION_ALIAS_MEMBERS_TABLE,
  MENTION_ALIASES_TABLE,
  PINNED_WAVES_TABLE,
  PROFILE_PREFERENCES_TABLE,
  PUSH_NOTIFICATION_SETTINGS_TABLE,
  SIGNED_RECORD_HEADS_TABLE,
  WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE
} from '@/constants';
import { DropType } from '@/entities/IDrop';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import { ProfileNotificationLevel } from '@/entities/IProfilePreferences';
import { contentModerationDb } from '@/content-moderation/content-moderation.db';
import { mentionAliasesDb } from '@/mention-aliases/mention-aliases.db';
import { artistArtworkAlertsDb } from '@/notifications/artist-artwork-alerts.db';
import { waveGroupNotificationSubscriptionsDb } from '@/notifications/wave-group-notification-subscriptions.db';
import { profilePreferencesDb } from '@/profile-preferences/profile-preferences.db';
import { sqlExecutor } from '@/sql-executor';
import { dropBookmarksDb } from '@/api/drops/drop-bookmarks.db';
import { identityMutesDb } from '@/api/identity-mutes/identity-mutes.db';
import { identitySubscriptionsDb } from '@/api/identity-subscriptions/identity-subscriptions.db';
import { saveEULAConsent } from '@/api/policies/policies.db';
import { pushNotificationSettingsDb } from '@/api/push-notifications/push-notification-settings.db';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import {
  signRecordEvent,
  SignedRecordEvent
} from '@/signed-records/record-event';
import {
  RecordIndexer,
  RecordRegistry,
  SenderKeyring
} from '@/signed-records/record-index';
import { RecordKind } from '@/signed-records/record-kinds';
import {
  grantSource,
  hexBytes,
  VECTOR_GRANT,
  vectorDeviceKey,
  VECTORS
} from '@/signed-records/record-test-fixtures';
import {
  verifyRecordEvent,
  VerifiedRecord
} from '@/signed-records/record-verify';
import { importOrderKey } from '@/signed-records/record-order';
import type { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import { SealedClass, sealItems } from '@/signed-records/sealed-crypto';
import { SignedRecordHeadsDb } from '@/signed-records/signed-record-heads.db';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import {
  PersonalExportDb,
  PersonalImportBody,
  PersonalImportBuilder,
  PersonalImportDone,
  rebuildPersonalState
} from './personal-import';
import { personalModerationAuditRows } from './personal-moderation-audit';
import { checkPersonalItem } from './personal-record-checks';
import { registerPersonalRecordTypes } from './personal-record-types';
import type { PersonalLiveEffects } from './personal-records.ports';
import { PersonalRecordsService } from './personal-records.service';
import { FixtureOwnerDirectory } from './personal-records.test-fixtures';
import { personalTables } from './personal-records.wiring';

const inputs = VECTORS.inputs;
// The vectors' principal and device: records here are signed with them.
const P_ME = inputs.principal;
const P_ALICE = `0x${'0'.repeat(63)}2`;
const P_BOB = `0x${'0'.repeat(63)}3`;
const ME = 'rebuild-me';
const ALICE = 'rebuild-alice';
const BOB = 'rebuild-bob';
const WAVE = 'rebuild-wave-0000-4000-8000-000000000001';
const DROP = 'rebuild-drop-0000-4000-8000-000000000001';
const DEVICE = 'rebuild-push-device';
const READER = `0x${'5'.repeat(40)}`;
const ANCHOR_T = 1000;
const T = VECTORS.followRecord.claimed_time;
const provider = {
  id: inputs.providerKeyId,
  privateKey: hexBytes(inputs.providerPrivateKey),
  publicKey: hexBytes(inputs.providerPublicKey)
};
const ctx = {};

const identity = (profileId: string, handle: string, wallet: string) =>
  anIdentity(
    {},
    {
      consolidation_key: wallet,
      profile_id: profileId,
      primary_address: wallet,
      handle
    }
  );

/** Visibility from the seeded waves and drops; no notifications. */
const live: PersonalLiveEffects = {
  canSeeWave: (_profileId, waveId, c) => personalTables.waveExists(waveId, c),
  canSeeDrop: async (_profileId, dropId, c) =>
    (await personalTables.waveOfDrop(dropId, c)) !== null,
  isSelectableGroup: async () => true,
  notifyNewFollower: async () => undefined,
  wavesChanged: async () => undefined,
  recordActiveIdentity: async () => undefined,
  waveFollowChanged: async () => undefined,
  muteChanged: async () => undefined
};

let seq = 1_950_000_000_000;
function signed(
  kind: RecordKind,
  wave: string,
  refs: string[],
  body: object | null,
  anchor = ANCHOR_T + 1
): SignedRecordEvent {
  seq += 1;
  return signRecordEvent(
    {
      kind,
      wave,
      refs,
      body,
      author: inputs.author,
      deviceKey: inputs.deviceKey,
      authRef: inputs.authRef,
      seq,
      anchor,
      claimedTime: T + (seq % 1000) + 1
    },
    vectorDeviceKey()
  );
}

function settings(
  items: { t: string; k: string; b: object | null }[],
  anchor = ANCHOR_T + 1
) {
  const wave = `pv/${P_ME}`;
  const c = sealItems({
    wave,
    cls: SealedClass.PROVIDER,
    gen: 1,
    deviceKey: inputs.deviceKey,
    senderKey: hexBytes(inputs.senderKey),
    items: items as never
  });
  return signed(
    RecordKind.SEALED,
    wave,
    ['settings'],
    { c: c.toString('base64url'), v: 1 },
    anchor
  );
}

/** What the API reads, per table, without auto ids and housekeeping times. */
async function answers(): Promise<Record<string, unknown>> {
  const rows = (sql: string) => sqlExecutor.execute(sql);
  return {
    follows: await rows(
      `select subscriber_id, target_id, target_type, target_action, wave_id, subscribed_to_all_drops
       from ${IDENTITY_SUBSCRIPTIONS_TABLE} order by 1, 2, 3, 4`
    ),
    waveGroups: await rows(
      `select identity_id, wave_id, mentioned_group
       from ${WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE} order by 1, 2, 3`
    ),
    mutes: await rows(
      `select muter_id, muted_identity_id, created_at from ${IDENTITY_MUTES_TABLE} order by 1, 2`
    ),
    blocks: await rows(
      `select blocker_profile_id, blocked_profile_id, created_at
       from ${CONTENT_MODERATION_PROFILE_BLOCKS_TABLE} order by 1, 2`
    ),
    hidden: await rows(
      `select profile_id, drop_id, created_at from ${CONTENT_MODERATION_HIDDEN_DROPS_TABLE} order by 1, 2`
    ),
    bookmarks: await rows(
      `select identity_id, drop_id, bookmarked_at from ${DROP_BOOKMARKS_TABLE} order by 1, 2`
    ),
    alerts: await rows(
      `select subscriber_id, artist_id, enabled_at from ${ARTIST_ARTWORK_ALERTS_TABLE} order by 1, 2`
    ),
    pins: await rows(
      `select profile_id, wave_id, position from ${PINNED_WAVES_TABLE} order by 1, 2`
    ),
    preferences: [
      await profilePreferencesDb.get(ME),
      await profilePreferencesDb.get(ALICE)
    ],
    aliases: await mentionAliasesDb.findByOwner(ME),
    push: await pushNotificationSettingsDb.getPushNotificationSettings(
      ME,
      DEVICE
    ),
    eula: await rows(
      `select device_id, platform, accepted_at, eula_version, profile_id
       from ${EULA_CONSENT_TABLE} where profile_id is not null order by 1`
    )
  };
}

/** Every head: per key, and the service's own (`~owner`, `~keys`, `~reader`). */
async function headRows(): Promise<Record<string, unknown>[]> {
  return sqlExecutor.execute<Record<string, unknown>>(
    `select owner, family, rtype, rkey, anchor, claimed_time, event_id
     from ${SIGNED_RECORD_HEADS_TABLE} order by owner, family, rtype, rkey`
  );
}

/** The audit rows of the people's own blocks and hides, oldest first. */
async function personalAuditRows(): Promise<Record<string, unknown>[]> {
  const rows = await sqlExecutor.execute<Record<string, unknown>>(
    `select actor_profile_id, action, target_profile_id, target_drop_id,
            previous_state, new_state, created_at
     from ${CONTENT_MODERATION_AUDIT_LOG_TABLE}
     where actor_profile_id in (:ids)
       and action in ('PROFILE_BLOCKED', 'PROFILE_UNBLOCKED', 'DROP_HIDDEN', 'DROP_UNHIDDEN')
     order by created_at, id`,
    { ids: [ME, ALICE, BOB] }
  );
  return rows.map((row) => ({ ...row, created_at: Number(row.created_at) }));
}

async function emptyTables() {
  for (const table of [
    IDENTITY_SUBSCRIPTIONS_TABLE,
    WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE,
    IDENTITY_MUTES_TABLE,
    CONTENT_MODERATION_PROFILE_BLOCKS_TABLE,
    CONTENT_MODERATION_HIDDEN_DROPS_TABLE,
    DROP_BOOKMARKS_TABLE,
    ARTIST_ARTWORK_ALERTS_TABLE,
    PINNED_WAVES_TABLE,
    PROFILE_PREFERENCES_TABLE,
    MENTION_ALIAS_MEMBERS_TABLE,
    MENTION_ALIASES_TABLE,
    PUSH_NOTIFICATION_SETTINGS_TABLE,
    EULA_CONSENT_TABLE,
    SIGNED_RECORD_HEADS_TABLE
  ]) {
    await sqlExecutor.execute(`delete from ${table}`);
  }
}

describeWithSeed(
  'personal settings: rebuild from empty',
  [
    withIdentities([
      identity(ME, 'rebuildme', `0x${'a'.repeat(40)}`),
      identity(ALICE, 'rebuildalice', `0x${'b'.repeat(40)}`),
      identity(BOB, 'rebuildbob', `0x${'c'.repeat(40)}`)
    ]),
    withProfiles([
      aProfile({
        external_id: ME,
        handle: 'rebuildme',
        primary_wallet: `0x${'a'.repeat(40)}`
      }),
      aProfile({
        external_id: ALICE,
        handle: 'rebuildalice',
        primary_wallet: `0x${'b'.repeat(40)}`
      }),
      aProfile({
        external_id: BOB,
        handle: 'rebuildbob',
        primary_wallet: `0x${'c'.repeat(40)}`
      })
    ]),
    withWaves([
      aWave(
        { visibility_group_id: null, created_by: BOB },
        { id: WAVE, name: WAVE }
      )
    ]),
    {
      table: DROPS_TABLE,
      rows: [
        {
          id: DROP,
          serial_no: 1,
          wave_id: WAVE,
          author_id: ALICE,
          created_at: 1_000,
          updated_at: null,
          title: null,
          parts_count: 1,
          reply_to_drop_id: null,
          reply_to_part_id: null,
          drop_type: DropType.CHAT,
          signature: null,
          hide_link_preview: false
        }
      ]
    }
  ],
  () => {
    it('gives the same answers after emptying the tables and rebuilding from the import and the records', async () => {
      // 1. Today's state, written by today's routes' db calls.
      await identitySubscriptionsDb.executeNativeQueriesInTransaction(
        async (connection) => {
          await identitySubscriptionsDb.addIdentitySubscription(
            {
              subscriber_id: ME,
              target_id: ALICE,
              target_type: ActivityEventTargetType.IDENTITY,
              target_action: ActivityEventAction.DROP_CREATED,
              wave_id: null,
              subscribed_to_all_drops: false
            },
            connection
          );
          await identitySubscriptionsDb.addIdentitySubscription(
            {
              subscriber_id: ME,
              target_id: WAVE,
              target_type: ActivityEventTargetType.WAVE,
              target_action: ActivityEventAction.DROP_CREATED,
              wave_id: WAVE,
              subscribed_to_all_drops: false
            },
            connection
          );
          await waveGroupNotificationSubscriptionsDb.addDefaultGroupsForWaveSubscription(
            ME,
            WAVE,
            connection
          );
          // Drop creation's auto-follow of the author; the wave's creator
          // (Bob) has unfollowed his own wave.
          await identitySubscriptionsDb.addIdentitySubscription(
            {
              subscriber_id: ALICE,
              target_id: DROP,
              target_type: ActivityEventTargetType.DROP,
              target_action: ActivityEventAction.DROP_REPLIED,
              wave_id: WAVE,
              subscribed_to_all_drops: false
            },
            connection
          );
          await identitySubscriptionsDb.subscribeToAllDrops(
            ME,
            WAVE,
            connection
          );
          await mentionAliasesDb.insertAlias(
            {
              id: randomUUID(),
              ownerProfileId: ME,
              alias: 'friends',
              normalizedAlias: 'friends'
            },
            connection
          );
          const [alias] = await mentionAliasesDb.findByOwner(ME, connection);
          await mentionAliasesDb.replaceMembers(
            alias.id,
            [ALICE, BOB],
            connection
          );
        }
      );
      await identityMutesDb.muteIdentity(
        { muter_id: ME, muted_identity_id: BOB },
        {},
        1_111
      );
      // A block undone before the switch: history only.
      await contentModerationDb.blockProfile(ME, BOB, {}, 1_200);
      await contentModerationDb.unblockProfile(ME, BOB, {}, 1_210);
      await contentModerationDb.blockProfile(ALICE, BOB, {}, 1_222);
      await contentModerationDb.hideDrop(ME, DROP, {}, 1_333);
      await dropBookmarksDb.insertBookmark({
        identity_id: ME,
        drop_id: DROP,
        bookmarked_at: 1_444
      });
      await artistArtworkAlertsDb.setEnabled(
        { subscriberId: ME, artistId: ALICE },
        true,
        {},
        1_555
      );
      await wavesApiDb.updatePinnedWavePositions(
        ME,
        [{ wave_id: WAVE, position: 1 }],
        {}
      );
      await profilePreferencesDb.upsert(ME, {
        notification_level: ProfileNotificationLevel.ESSENTIAL_ONLY,
        notifications: { new_followers: false }
      });
      await pushNotificationSettingsDb.upsertPushNotificationSettings(
        ME,
        DEVICE,
        { drop_voted: false }
      );
      await saveEULAConsent(DEVICE, 'ios', '1.0', ME, { acceptedAt: 1_666 });

      // 2. A record from the shadow days, before the import: checked and
      // logged, never applied. The import holds the outcome of its key.
      const owners = new FixtureOwnerDirectory(
        new Map([
          [P_ME, ME],
          [P_ALICE, ALICE],
          [P_BOB, BOB]
        ]),
        [{ wallet: inputs.author, principal: P_ME, from: 1 }]
      );
      const heads = new SignedRecordHeadsDb(() => sqlExecutor);
      const deps = { owners, tables: personalTables, live };
      const registry = registerPersonalRecordTypes(new RecordRegistry(), deps);
      const logged: SignedRecordEvent[] = [];
      let importOrder: ReturnType<typeof importOrderKey> | null = null;
      const service = new PersonalRecordsService({
        grants: grantSource([VECTOR_GRANT]),
        owners,
        anchors: {
          getAnchor: async () => ({
            anchor: ANCHOR_T + 50,
            headHeight: ANCHOR_T + 52,
            finalizedTime: T,
            maxAnchorLag: 120
          })
        },
        heads,
        registry,
        providers: () => [provider],
        log: {
          appendEvents: async (_lane, events) => {
            logged.push(...events);
          }
        },
        importOrder: async () => importOrder,
        now: () => T,
        maxClockSkewMs: 10 * 60 * 1000
      });
      const keys = VECTORS.keys.event;
      const shadowBookmark = settings(
        [{ t: 'bookmark', k: DROP, b: {} }],
        ANCHOR_T - 1
      );
      expect(
        (await service.submit([keys, shadowBookmark], 'shadow', ME, ctx)).map(
          (result) => result.outcome
        )
      ).toEqual(['logged', 'applied']);
      // ... and today's route then removed the bookmark, writing no record.
      await dropBookmarksDb.deleteBookmark({ identity_id: ME, drop_id: DROP });

      // 3. The one-time import at the switch, a page of owners at a time.
      const principals = new Map([
        [ME, P_ME],
        [ALICE, P_ALICE],
        [BOB, P_BOB]
      ]);
      const exportDb = new PersonalExportDb(() => sqlExecutor);
      const emitted: RecordLogEntry[] = [];
      const builder = new PersonalImportBuilder({
        anchor: ANCHOR_T,
        at: T,
        ownersOf: async (ids) =>
          new Map(
            ids
              .filter((id) => principals.has(id))
              .map((id) => [id, principals.get(id)!])
          ),
        check: checkPersonalItem,
        emit: async (entries) => {
          emitted.push(...entries);
        }
      });
      for await (const ids of exportDb.ownerPages()) {
        await builder.addPage(await exportDb.readPage(ids));
      }
      expect((await builder.finish()).skipped).toEqual({});
      importOrder = importOrderKey(ANCHOR_T, T);
      // The public chain's entries, then the private chain's, as replay reads them.
      const chainOf = (entry: RecordLogEntry) =>
        (entry as { chain: string }).chain;
      const bodies = [
        ...emitted.filter((entry) => chainOf(entry) === 'public'),
        ...emitted.filter((entry) => chainOf(entry) === 'private')
      ].map(
        (entry) =>
          (entry as { body: unknown }).body as
            | PersonalImportBody
            | PersonalImportDone
      );
      // Follows of waves and drops are not public.
      expect(
        bodies
          .filter((body) => 'family' in body && body.family === 'ps')
          .flatMap((body) =>
            (body as PersonalImportBody).items.map((item) => item.k)
          )
      ).toEqual([`identity:${P_ALICE}`]);

      // 4. Signed records after the switch, applied live (primary).
      const events = [
        keys,
        signed(
          RecordKind.RECORD,
          `ps/${P_ME}`,
          ['follow', `identity:${P_ALICE}`],
          { actions: ['DROP_CREATED', 'DROP_REPLIED'] }
        ),
        settings([
          { t: 'mute', k: P_BOB, b: null },
          { t: 'mute', k: P_ALICE, b: {} },
          { t: 'bookmark', k: DROP, b: {} },
          { t: 'pin', k: WAVE, b: { pos: 7 } },
          { t: 'pref', k: 'level', b: null },
          {
            t: 'wave-notify',
            k: WAVE,
            b: { all_drops: false, groups: ['ADMINS'] }
          },
          { t: 'follow', k: `drop:${DROP}`, b: { actions: ['DROP_REPLIED'] } },
          { t: 'alias', k: 'friends', b: { members: [P_BOB] } },
          { t: 'alias', k: 'pair', b: { members: [P_ALICE, P_BOB] } }
        ]),
        settings([
          { t: 'block', k: P_BOB, b: {} },
          { t: 'hide', k: DROP, b: null }
        ]),
        signed(RecordKind.RECORD, `pv/${P_ME}`, ['reader', READER], {})
      ];
      const results = await service.submit(events, 'primary', ME, ctx);
      expect(results.map((result) => result.outcome)).toEqual([
        'stale',
        'applied',
        'applied',
        'applied',
        'logged'
      ]);
      const before = await answers();
      // Per key, and the service's own: the owner's mark, the keys and the
      // reader already logged.
      const headsBefore = await headRows();
      expect(
        headsBefore
          .map((row) => row.rtype as string)
          .filter((type) => type.startsWith('~'))
      ).toEqual(['~keys', '~owner', '~reader']);
      const auditBefore = await personalAuditRows();
      expect(
        auditBefore.map((row) => [row.actor_profile_id, row.action])
      ).toEqual([
        [ME, 'PROFILE_BLOCKED'],
        [ME, 'PROFILE_UNBLOCKED'],
        [ALICE, 'PROFILE_BLOCKED'],
        [ME, 'DROP_HIDDEN'],
        [ME, 'PROFILE_BLOCKED'],
        [ME, 'DROP_UNHIDDEN']
      ]);
      expect(before).toMatchObject({
        mutes: [{ muter_id: ME, muted_identity_id: ALICE }],
        pins: [{ profile_id: ME, wave_id: WAVE, position: 7 }]
      });

      // 5. Every table empty, then the rebuild: what the waves index
      // implies, the import, and the logged records after it.
      await emptyTables();
      const verified: VerifiedRecord[] = [];
      for (const event of logged) {
        const result = await verifyRecordEvent(event, {
          grants: grantSource([VECTOR_GRANT]),
          bindings: owners
        });
        if (!result.ok) throw new Error(result.reason);
        verified.push(result.record);
      }
      const report = await rebuildPersonalState({
        indexer: new RecordIndexer({
          registry,
          heads,
          keyring: new SenderKeyring([provider])
        }),
        heads,
        imports: bodies,
        records: verified,
        derive: (c) => exportDb.deriveFromWavesIndex(c),
        ctx
      });
      expect(report.refused).toEqual([]);
      // The shadow-period bookmark stays out.
      expect(report.beforeImport).toBe(1);
      expect(await answers()).toEqual(before);
      // The same heads: none for the import, which live never indexes.
      expect(await headRows()).toEqual(headsBefore);

      // 6. The audit rows of their own blocks and hides, for the audit
      // log's rebuild: the import's history, then the records', each at
      // its own time, the same rows today's routes and the records wrote.
      const audit = await personalModerationAuditRows({
        imports: bodies,
        records: verified,
        providers: [provider],
        owners
      });
      expect(
        audit.map((row) => ({
          actor_profile_id: row.actorProfileId,
          action: row.action,
          target_profile_id: row.targetProfileId,
          target_drop_id: row.targetDropId,
          previous_state: row.previousState,
          new_state: row.newState,
          created_at: row.createdAt
        }))
      ).toEqual(auditBefore);

      // 7. Rows whose owner has no profile are never read by the import's
      // pages; the import counts them instead.
      expect(await exportDb.countRowsWithoutProfile()).toEqual({});
      await identityMutesDb.muteIdentity(
        { muter_id: 'rebuild-gone-profile', muted_identity_id: BOB },
        {},
        1_777
      );
      expect(await exportDb.countRowsWithoutProfile()).toEqual({
        [IDENTITY_MUTES_TABLE]: 1
      });
    });
  }
);
