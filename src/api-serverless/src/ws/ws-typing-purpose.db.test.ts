import 'reflect-metadata';
import { mock } from 'ts-jest-mocker';
import WebSocket, { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { WsConnectionRepository } from '@/api/ws/ws-connection.repository';
import { ANON_USER_ID, AppWebSockets } from '@/api/ws/ws';
import { WsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import { WsMessageType } from '@/api/ws/ws-message';
import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { WS_CONNECTIONS_TABLE, XTDH_STATS_META_TABLE } from '@/constants';
import {
  WSConnectionEntity,
  WsConnectionPurpose
} from '@/entities/IWSConnection';

const member = anIdentity({ level_raw: 0, tdh: 20 });
const viewer = anIdentity({ level_raw: 0, tdh: 20 });
const everyone = aUserGroup({ level_min: 0 });
const publicWave = aWave({ visibility_group_id: null });
const groupWave = aWave({ visibility_group_id: everyone.id });

function socketRow(
  connectionId: string,
  identityId: string,
  waveId: string | null,
  purpose: WsConnectionPurpose | null
): WSConnectionEntity {
  return {
    connection_id: connectionId,
    identity_id: identityId,
    wave_id: waveId,
    jwt_expiry: 4102444800,
    purpose
  };
}

const ids = (rows: { connectionId: string }[]) =>
  rows.map((row) => row.connectionId).sort((a, b) => a.localeCompare(b));

describeWithSeed(
  'Typing-purpose sockets (waves 0.12a)',
  [
    withIdentities([member, viewer]),
    withUserGroups([everyone]),
    withWaves([publicWave, groupWave]),
    {
      table: WS_CONNECTIONS_TABLE,
      rows: [
        socketRow('app', member.profile_id!, null, null),
        socketRow('legacy-open', viewer.profile_id!, publicWave.id, null),
        socketRow(
          'typing-public',
          member.profile_id!,
          publicWave.id,
          WsConnectionPurpose.TYPING
        ),
        socketRow(
          'typing-anonymous',
          ANON_USER_ID,
          publicWave.id,
          WsConnectionPurpose.TYPING
        ),
        socketRow(
          'typing-group',
          member.profile_id!,
          groupWave.id,
          WsConnectionPurpose.TYPING
        )
      ]
    },
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

    it.each([false, true])(
      'leaves typing sockets out of a public wave audience (system=%s)',
      async (system) => {
        const rows = system
          ? await repo.getCurrentlyOnlineCommunityMemberConnectionIdsForSystemBroadcast(
              { waveId: publicWave.id, groupId: null },
              {}
            )
          : await repo.getCurrentlyOnlineCommunityMemberConnectionIds(
              { waveId: publicWave.id, groupId: null },
              {}
            );
        expect(ids(rows)).toEqual(['app', 'legacy-open']);
      }
    );

    it('keeps typing sockets in the typing audience', async () => {
      const rows = await repo.getCurrentlyOnlineCommunityMemberConnectionIds(
        { waveId: publicWave.id, groupId: null },
        {},
        { includeTypingSockets: true }
      );
      expect(ids(rows.filter((row) => row.wave_id === publicWave.id))).toEqual([
        'legacy-open',
        'typing-anonymous',
        'typing-public'
      ]);
    });

    it.each([false, true])(
      'leaves typing sockets out of a grouped wave audience (system=%s)',
      async (system) => {
        const rows = system
          ? await repo.getCurrentlyOnlineCommunityMemberConnectionIdsForSystemBroadcast(
              { waveId: groupWave.id, groupId: null },
              {}
            )
          : await repo.getCurrentlyOnlineCommunityMemberConnectionIds(
              { waveId: groupWave.id, groupId: null },
              {}
            );
        expect(ids(rows)).toEqual(['app', 'legacy-open']);
        const typing =
          await repo.getCurrentlyOnlineCommunityMemberConnectionIds(
            { waveId: groupWave.id, groupId: null },
            {},
            { includeTypingSockets: true }
          );
        expect(ids(typing)).toContain('typing-group');
      }
    );

    it('leaves typing sockets out of identity and global lookups', async () => {
      expect(
        (await repo.findConnectionIdsByIdentityId(member.profile_id!)).sort(
          (a, b) => a.localeCompare(b)
        )
      ).toEqual(['app']);
      expect(
        ids(
          await repo.findPrimaryConnectionIdsByIdentityIds([member.profile_id!])
        )
      ).toEqual(['app']);
      expect(
        ids(
          await repo.findNotificationConnectionIdsByIdentityIds([
            member.profile_id!
          ])
        )
      ).toEqual(['app']);
      expect(
        (await repo.findAllConnectionIds()).sort((a, b) => a.localeCompare(b))
      ).toEqual(['app', 'legacy-open']);
    });

    it('persists the declared purpose and null for legacy sockets', async () => {
      await sqlExecutor.execute(`delete from ${WS_CONNECTIONS_TABLE}`);
      const sockets = new AppWebSockets(repo);
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await once(server, 'listening');
      const address = server.address();
      if (typeof address === 'string' || address === null)
        throw new Error('Expected a TCP address');
      const clients: WebSocket[] = [];
      try {
        for (const [connectionId, purpose] of [
          ['typing-new', WsConnectionPurpose.TYPING],
          ['legacy-new', null]
        ] as const) {
          const connected = once(server, 'connection');
          const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
          clients.push(client);
          await once(client, 'open');
          const [socket] = (await connected) as [WebSocket];
          await sockets.register({
            identityId: member.profile_id!,
            connectionId,
            jwtExpiry: 4102444800,
            ws: socket,
            purpose
          });
        }
        const stored = await sqlExecutor.execute<{
          connection_id: string;
          purpose: string | null;
        }>(
          `select connection_id, purpose from ${WS_CONNECTIONS_TABLE} order by connection_id`
        );
        expect(stored).toEqual([
          { connection_id: 'legacy-new', purpose: null },
          { connection_id: 'typing-new', purpose: WsConnectionPurpose.TYPING }
        ]);
      } finally {
        for (const client of clients) client.close();
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('delivers a drop once per tab: app socket only, never the typing socket', async () => {
      await sqlExecutor.execute(`delete from ${WS_CONNECTIONS_TABLE}`);
      const sockets = new AppWebSockets(repo);
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await once(server, 'listening');
      const address = server.address();
      if (typeof address === 'string' || address === null)
        throw new Error('Expected a TCP address');
      const received: Record<string, string[]> = {};
      const clients: WebSocket[] = [];
      try {
        for (const [connectionId, waveId, purpose] of [
          ['tab-app', null, null],
          ['tab-typing', publicWave.id, WsConnectionPurpose.TYPING],
          ['old-tab-typing', publicWave.id, null]
        ] as const) {
          const connected = once(server, 'connection');
          const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
          received[connectionId] = [];
          client.on('message', (data) =>
            received[connectionId].push(data.toString())
          );
          clients.push(client);
          await once(client, 'open');
          const [socket] = (await connected) as [WebSocket];
          await sockets.register({
            identityId: member.profile_id!,
            connectionId,
            jwtExpiry: 4102444800,
            ws: socket,
            purpose
          });
          if (waveId)
            await sockets.updateActiveWaveForConnection(
              { connectionId, activeWaveId: waveId },
              {}
            );
        }
        const notifier = new WsListenersNotifier(sockets, repo, {
          getViewerContextsForDrop: async () => ({})
        });
        await notifier.notifyAboutDropUpdate(
          Object.assign(new ApiDrop(), {
            id: 'typing-purpose-drop',
            serial_no: 9,
            drop_type: ApiDropType.Chat,
            author: { id: viewer.profile_id, subscribed_actions: [] },
            wave: { id: publicWave.id, visibility_group_id: null },
            parts: [{ content: 'one copy per tab' }],
            reactions: []
          }),
          {}
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        const dropFrames = (connectionId: string) =>
          received[connectionId].filter(
            (frame) => JSON.parse(frame).type === WsMessageType.DROP_UPDATE
          );
        expect(dropFrames('tab-app')).toHaveLength(1);
        expect(dropFrames('tab-typing')).toHaveLength(0);
        // An old frontend's typing socket keeps its legacy drop copy.
        expect(dropFrames('old-tab-typing')).toHaveLength(1);
      } finally {
        for (const client of clients) client.close();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  }
);
