import 'reflect-metadata';
import fc from 'fast-check';
import { mock } from 'ts-jest-mocker';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { withProfileGroups } from '@/tests/fixtures/profile-group.fixture';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { WsConnectionRepository } from '@/api/ws/ws-connection.repository';
import { ANON_USER_ID, AppWebSockets } from '@/api/ws/ws';
import WebSocket, { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { WsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import { WsMessageType } from '@/api/ws/ws-message';
import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import {
  IDENTITIES_TABLE,
  WS_CONNECTIONS_TABLE,
  WAVES_TABLE,
  USER_GROUPS_TABLE,
  XTDH_STATS_META_TABLE
} from '@/constants';
import { NotFoundException } from '@/exceptions';
import { IdentityEntity } from '@/entities/IIdentity';
import { WSConnectionEntity } from '@/entities/IWSConnection';

const allowed = anIdentity({ level_raw: 0, tdh: 20 });
const childOnly = anIdentity({ level_raw: 0, tdh: 0 });
const parentOnly = anIdentity({ level_raw: -1, tdh: 20 });
const denied = anIdentity({ level_raw: -1, tdh: 0 });
const mixedEligible = anIdentity({ level_raw: 5, tdh: 0 });
const mixedIneligible = {
  ...anIdentity({ level_raw: -1 }),
  profile_id: mixedEligible.profile_id
};
const noProfile = { ...anIdentity({ level_raw: 0 }), profile_id: null };
const identities = [
  allowed,
  childOnly,
  parentOnly,
  denied,
  mixedEligible,
  mixedIneligible,
  noProfile
];
const zero = aUserGroup({ level_min: 0 });
const parentGroup = aUserGroup({ tdh_min: 10 });
const privateZero = aUserGroup({ level_min: 0, is_private: true });
const excluded = aUserGroup({
  level_min: 0,
  excluded_profile_group_id: 'excluded-profiles'
});
const included = aUserGroup({
  level_min: 0,
  profile_group_id: 'included-profiles'
});
const nft = aUserGroup({ level_min: 0, owns_meme: true });
const rep = aUserGroup({ level_min: 0, rep_min: 10 });
const upper = aUserGroup({ level_min: 0, level_max: 0 });
const grant = aUserGroup({
  level_min: 0,
  is_beneficiary_of_grant_id: 'required-grant'
});
const parent = aWave({ visibility_group_id: parentGroup.id });
const child = aWave({
  visibility_group_id: zero.id,
  parent_wave_id: parent.id
});
const standalone = aWave({ visibility_group_id: zero.id });
const privateWave = aWave({ visibility_group_id: privateZero.id });

/** Creates a persisted socket fixture with an expiry beyond the test period. */
function connection(
  connectionId: string,
  identityId: string | null,
  waveId: string | null = null
): WSConnectionEntity {
  return {
    connection_id: connectionId,
    identity_id: identityId,
    wave_id: waveId,
    jwt_expiry: 4102444800
  };
}

const sockets = [
  connection('allowed', allowed.profile_id, child.id),
  connection('allowed-second', allowed.profile_id),
  connection('allowed-other-wave', allowed.profile_id, 'other-wave'),
  connection('child-only', childOnly.profile_id, child.id),
  connection('parent-only', parentOnly.profile_id, child.id),
  connection('denied', denied.profile_id, child.id),
  connection('mixed', mixedEligible.profile_id),
  connection('missing', 'missing-profile', child.id),
  connection('anonymous', ANON_USER_ID, child.id)
];

type Recipient = {
  connectionId: string;
  profileId: string | null;
  wave_id: string | null;
};

/** Sorts complete recipient rows without removing duplicates from the comparison. */
function sortedRows(rows: Recipient[]): string[] {
  return rows
    .map((row) =>
      JSON.stringify([row.connectionId, row.profileId, row.wave_id])
    )
    .sort((a, b) => a.localeCompare(b));
}

describeWithSeed(
  'Online recipient SQL and access rules',
  [
    withIdentities(identities),
    withUserGroups([
      zero,
      parentGroup,
      privateZero,
      excluded,
      included,
      nft,
      rep,
      upper,
      grant
    ]),
    withWaves([parent, child, standalone, privateWave]),
    withProfileGroups([
      {
        profile_group_id: 'excluded-profiles',
        profile_id: allowed.profile_id!
      },
      { profile_group_id: 'included-profiles', profile_id: denied.profile_id! }
    ]),
    { table: WS_CONNECTIONS_TABLE, rows: sockets },
    {
      table: XTDH_STATS_META_TABLE,
      rows: [
        {
          id: 1,
          active_slot: 'a',
          as_of_midnight_ms: 0,
          last_updated_at: new Date(0)
        }
      ]
    }
  ],
  () => {
    const service = new UserGroupsService(
      new UserGroupsDb(() => sqlExecutor),
      mock(),
      mock()
    );
    const repo = new WsConnectionRepository(
      () => sqlExecutor,
      service,
      () => false
    );

    afterEach(() => jest.restoreAllMocks());

    /** Executes the real generated query for comparison with the optimized path. */
    async function groupRecipients(
      groupId: string,
      optimized: boolean
    ): Promise<Recipient[]> {
      const result = await service.getSqlAndParamsByGroupId(
        groupId,
        {},
        { forOnlineRecipients: optimized }
      );
      if (!result) throw new Error('Expected a group query');
      return sqlExecutor.execute<Recipient>(
        `
      ${result.sql}
      select ws.connection_id as connectionId, ws.identity_id as profileId, ws.wave_id
      from ${WS_CONNECTIONS_TABLE} ws
      join ${UserGroupsService.GENERATED_VIEW} cm on ws.identity_id = cm.profile_id
    `,
        result.params
      );
    }

    it('returns exactly the same rows, including duplicate profiles and cross-wave sockets', async () => {
      const original = await groupRecipients(zero.id, false);
      const optimized = await groupRecipients(zero.id, true);
      expect(sortedRows(optimized)).toEqual(sortedRows(original));
      expect(
        optimized
          .map((row) => row.connectionId)
          .sort((a, b) => a.localeCompare(b))
      ).toEqual([
        'allowed',
        'allowed-other-wave',
        'allowed-second',
        'child-only',
        'mixed',
        'mixed'
      ]);
      const query = await service.getSqlAndParamsByGroupId(
        zero.id,
        {},
        { forOnlineRecipients: true }
      );
      expect(query?.sql).toContain('where exists');
      expect(query?.sql).not.toContain('included_profile_ids');
    });

    it.each([excluded, included, nft, rep, upper, grant])(
      'preserves additional restrictions for group $id',
      async (group) => {
        expect(sortedRows(await groupRecipients(group.id, true))).toEqual(
          sortedRows(await groupRecipients(group.id, false))
        );
        const query = await service.getSqlAndParamsByGroupId(
          group.id,
          {},
          { forOnlineRecipients: true }
        );
        expect(query?.sql).toContain('included_profile_ids');
      }
    );

    it('excludes a restricted profile and denies audiences with unmet NFT, reputation or grant rules', async () => {
      expect(
        (await groupRecipients(excluded.id, true)).some(
          (row) => row.profileId === allowed.profile_id
        )
      ).toBe(false);
      expect(
        (await groupRecipients(included.id, true)).some(
          (row) => row.profileId === denied.profile_id
        )
      ).toBe(true);
      for (const group of [nft, rep, grant]) {
        expect(await groupRecipients(group.id, true)).toEqual([]);
      }
    });

    it.each([false, true])(
      'requires both parent and child access (system=%s)',
      async (system) => {
        const result = system
          ? await repo.getCurrentlyOnlineCommunityMemberConnectionIdsForSystemBroadcast(
              { waveId: child.id, groupId: null },
              {}
            )
          : await repo.getCurrentlyOnlineCommunityMemberConnectionIds(
              { waveId: child.id, groupId: null },
              {}
            );
        expect(
          result
            .map((row) => row.connectionId)
            .sort((a, b) => a.localeCompare(b))
        ).toEqual(['allowed', 'allowed-other-wave', 'allowed-second']);
      }
    );

    it('rereads parent and child audience changes for already-connected users', async () => {
      await sqlExecutor.execute(
        `update ${WAVES_TABLE} set visibility_group_id = :groupId where id = :id`,
        { groupId: zero.id, id: parent.id }
      );
      expect(
        (
          await repo.getCurrentlyOnlineCommunityMemberConnectionIds(
            { waveId: child.id, groupId: null },
            {}
          )
        ).some((row) => row.connectionId === 'child-only')
      ).toBe(true);
      await sqlExecutor.execute(
        `update ${WAVES_TABLE} set visibility_group_id = :groupId where id = :id`,
        { groupId: excluded.id, id: child.id }
      );
      const after = await repo.getCurrentlyOnlineCommunityMemberConnectionIds(
        { waveId: child.id, groupId: zero.id },
        {}
      );
      expect(after.some((row) => row.profileId === allowed.profile_id)).toBe(
        false
      );
      expect(after.some((row) => row.connectionId === 'child-only')).toBe(true);
    });

    it.each(['missing', 'nested'])(
      'sends nothing for a %s parent',
      async (state) => {
        if (state === 'missing') {
          await sqlExecutor.execute(
            `delete from ${WAVES_TABLE} where id = :id`,
            { id: parent.id }
          );
        } else {
          await sqlExecutor.execute(
            `update ${WAVES_TABLE} set parent_wave_id = :id where id = :parent`,
            { id: standalone.id, parent: parent.id }
          );
        }
        expect(
          await repo.getCurrentlyOnlineCommunityMemberConnectionIds(
            { waveId: child.id, groupId: null },
            {}
          )
        ).toEqual([]);
        expect(
          await repo.getCurrentlyOnlineCommunityMemberConnectionIdsForSystemBroadcast(
            { waveId: child.id, groupId: null },
            {}
          )
        ).toEqual([]);
      }
    );

    it('retains normal private-group access checks and the existing system-broadcast distinction', async () => {
      await expect(
        repo.getCurrentlyOnlineCommunityMemberConnectionIds(
          { waveId: privateWave.id, groupId: zero.id },
          {}
        )
      ).rejects.toBeInstanceOf(NotFoundException);
      const system =
        await repo.getCurrentlyOnlineCommunityMemberConnectionIdsForSystemBroadcast(
          { waveId: privateWave.id, groupId: null },
          {}
        );
      expect(sortedRows(system)).toEqual(
        sortedRows(await groupRecipients(zero.id, false))
      );
    });

    it('does not broaden the audience when a group disappears', async () => {
      await sqlExecutor.execute(
        `delete from ${USER_GROUPS_TABLE} where id = :id`,
        { id: zero.id }
      );
      await expect(
        repo.getCurrentlyOnlineCommunityMemberConnectionIds(
          { waveId: standalone.id, groupId: null },
          {}
        )
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        await repo.getCurrentlyOnlineCommunityMemberConnectionIdsForSystemBroadcast(
          { waveId: standalone.id, groupId: null },
          {}
        )
      ).toEqual([]);
    });

    it.each([
      ['reaction', WsMessageType.DROP_REACTION_UPDATE],
      ['rating', WsMessageType.DROP_RATING_UPDATE],
      ['drop', WsMessageType.DROP_UPDATE]
    ])(
      'delivers %s updates over real sockets only to permitted, unexpired recipients',
      async (kind, messageType) => {
        await sqlExecutor.execute(`delete from ${WS_CONNECTIONS_TABLE}`);
        const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
        await once(server, 'listening');
        const address = server.address();
        if (typeof address === 'string' || address === null)
          throw new Error('Expected a TCP address');
        const appSockets = new AppWebSockets(repo);
        const clients: { id: string; client: WebSocket; messages: string[] }[] =
          [];
        const profiles = [
          ['allowed', allowed.profile_id!],
          ['child-only', childOnly.profile_id!],
          ['parent-only', parentOnly.profile_id!],
          ['denied', denied.profile_id!],
          ['anonymous', ANON_USER_ID],
          ['expired', allowed.profile_id!]
        ];
        try {
          for (const [id, identityId] of profiles) {
            const connected = once(server, 'connection');
            const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
            const messages: string[] = [];
            client.on('message', (data) => {
              messages.push(data.toString());
            });
            clients.push({ id, client, messages });
            await once(client, 'open');
            const [socket] = (await connected) as [WebSocket];
            await appSockets.register({
              identityId,
              connectionId: id,
              jwtExpiry: id === 'expired' ? 1 : 4102444800,
              ws: socket
            });
          }
          const notifier = new WsListenersNotifier(appSockets, repo, {
            getViewerContextsForDrop: async () => ({})
          });
          const notify = (drop: ApiDrop) => {
            if (kind === 'reaction')
              return notifier.notifyAboutDropReactionUpdate(drop, {});
            if (kind === 'rating')
              return notifier.notifyAboutDropRatingUpdate(drop, {});
            return notifier.notifyAboutDropUpdate(drop, {});
          };
          const drop = Object.assign(new ApiDrop(), {
            id: 'recipient-test-drop',
            serial_no: 7,
            drop_type: ApiDropType.Chat,
            author: { id: allowed.profile_id, subscribed_actions: [] },
            wave: { id: child.id, visibility_group_id: 'stale-payload-group' },
            parts: [{ content: 'Recipient access test' }],
            reactions: []
          });
          const expired = clients.find((entry) => entry.id === 'expired')!;
          const expiredClosed = once(expired.client, 'close');
          await notify(drop);
          await expiredClosed;

          // A marker on each connection proves all preceding frames were observed;
          // no timing sleep is needed to assert that blocked clients received none.
          const flushFrames = async () => {
            for (const { id, client } of clients.filter(
              (entry) => entry.id !== 'expired'
            )) {
              const received = new Promise<void>((resolve) => {
                const handler = (data: WebSocket.RawData) => {
                  if (data.toString() === 'barrier') {
                    client.off('message', handler);
                    resolve();
                  }
                };
                client.on('message', handler);
              });
              await appSockets.send({ connectionId: id, message: 'barrier' });
              await received;
            }
          };
          await flushFrames();
          for (const { id, messages } of clients) {
            const updates = messages
              .filter((message) => message !== 'barrier')
              .map((message) => JSON.parse(message));
            expect(updates).toHaveLength(id === 'allowed' ? 1 : 0);
            if (id === 'allowed') expect(updates[0].type).toBe(messageType);
          }

          await sqlExecutor.execute(
            `update ${WAVES_TABLE} set visibility_group_id = :groupId where id = :id`,
            { groupId: excluded.id, id: parent.id }
          );
          clients.forEach((entry) => {
            entry.messages.length = 0;
          });
          await notify(drop);
          await flushFrames();
          expect(
            clients
              .find((entry) => entry.id === 'allowed')!
              .messages.filter((message) => message !== 'barrier')
          ).toEqual([]);
        } finally {
          for (const { id, client } of clients) {
            await appSockets.deregister({ connectionId: id });
            client.terminate();
          }
          server.clients.forEach((socket) => socket.terminate());
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          );
        }
      }
    );

    it('matches the original SQL across generated identity and connection layouts', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              profile: fc.option(fc.integer({ min: 0, max: 5 }), { nil: null }),
              level: fc.integer({ min: -5, max: 5 })
            }),
            { maxLength: 20 }
          ),
          fc.array(
            fc.record({
              profile: fc.integer({ min: 0, max: 7 }),
              wave: fc.option(fc.constantFrom('a', 'b'), { nil: null })
            }),
            { maxLength: 15 }
          ),
          async (profileRows, connectionRows) => {
            await sqlExecutor.execute(`delete from ${WS_CONNECTIONS_TABLE}`);
            await sqlExecutor.execute(`delete from ${IDENTITIES_TABLE}`);
            const generated: IdentityEntity[] = profileRows.map(
              (row, index) => ({
                ...allowed,
                consolidation_key: `identity-${index}`,
                primary_address: `address-${index}`,
                profile_id:
                  row.profile === null ? null : `profile-${row.profile}`,
                level_raw: row.level
              })
            );
            const connections = connectionRows.map((row, index) =>
              connection(`socket-${index}`, `profile-${row.profile}`, row.wave)
            );
            if (generated.length)
              await sqlExecutor.bulkInsert(
                IDENTITIES_TABLE,
                generated,
                Object.keys(generated[0])
              );
            if (connections.length)
              await sqlExecutor.bulkInsert(
                WS_CONNECTIONS_TABLE,
                connections,
                Object.keys(connections[0])
              );
            expect(sortedRows(await groupRecipients(zero.id, true))).toEqual(
              sortedRows(await groupRecipients(zero.id, false))
            );
          }
        ),
        { numRuns: 25, seed: 6529 }
      );
    });
  }
);
