import 'reflect-metadata';
import { mock } from 'ts-jest-mocker';
import WebSocket, { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { WsConnectionRepository } from '@/api/ws/ws-connection.repository';
import { AppWebSockets } from '@/api/ws/ws';
import { WsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import { WsMessageType } from '@/api/ws/ws-message';
import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { WS_CONNECTIONS_TABLE } from '@/constants';

const reader = anIdentity({ level_raw: 0, tdh: 20 });
const author = anIdentity({ level_raw: 0, tdh: 20 });
const wave = aWave({ visibility_group_id: null });
const FAR_FUTURE = 4102444800;

describeWithSeed(
  'Fan-out JWT fence without per-recipient reads (waves 1.2)',
  [withIdentities([reader, author]), withWaves([wave])],
  () => {
    const repo = new WsConnectionRepository(
      () => sqlExecutor,
      new UserGroupsService(
        new UserGroupsDb(() => sqlExecutor),
        mock(),
        mock()
      ),
      () => false
    );

    afterEach(() => jest.restoreAllMocks());

    it('returns each stored expiry with the audience', async () => {
      await sqlExecutor.execute(
        `insert into ${WS_CONNECTIONS_TABLE} (connection_id, jwt_expiry, identity_id)
         values ('live', :live, :reader), ('expired', 1, :reader)`,
        { live: FAR_FUTURE, reader: reader.profile_id }
      );
      const rows = await repo.getCurrentlyOnlineCommunityMemberConnectionIds(
        { waveId: wave.id, groupId: null },
        {}
      );
      expect(
        rows
          .map(({ connectionId, jwtExpiry }) => ({ connectionId, jwtExpiry }))
          .sort((a, b) => a.connectionId.localeCompare(b.connectionId))
      ).toEqual([
        { connectionId: 'expired', jwtExpiry: 1 },
        { connectionId: 'live', jwtExpiry: FAR_FUTURE }
      ]);
    });

    it('delivers to live sockets with no connection reads and fences the expired one', async () => {
      const sockets = new AppWebSockets(repo);
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await once(server, 'listening');
      const address = server.address();
      if (typeof address === 'string' || address === null)
        throw new Error('Expected a TCP address');
      const received: Record<string, string[]> = {};
      const clients: WebSocket[] = [];
      try {
        for (const [connectionId, jwtExpiry] of [
          ['live-1', FAR_FUTURE],
          ['live-2', FAR_FUTURE],
          ['expired', 1]
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
            identityId: reader.profile_id!,
            connectionId,
            jwtExpiry,
            ws: socket
          });
        }
        const reads = jest.spyOn(repo, 'getByConnectionId');
        const notifier = new WsListenersNotifier(sockets, repo, {
          getViewerContextsForDrop: async () => ({})
        });

        await notifier.notifyAboutDropUpdate(
          Object.assign(new ApiDrop(), {
            id: 'fence-drop',
            serial_no: 3,
            drop_type: ApiDropType.Chat,
            author: { id: author.profile_id, subscribed_actions: [] },
            wave: { id: wave.id, visibility_group_id: null },
            parts: [{ content: 'fenced fan-out' }],
            reactions: []
          }),
          {}
        );
        await new Promise((resolve) => setTimeout(resolve, 200));

        const drops = (connectionId: string) =>
          received[connectionId].filter(
            (frame) => JSON.parse(frame).type === WsMessageType.DROP_UPDATE
          );
        expect(drops('live-1')).toHaveLength(1);
        expect(drops('live-2')).toHaveLength(1);
        expect(drops('expired')).toHaveLength(0);
        // Only the connection whose known expiry had passed was re-read.
        expect(reads.mock.calls.map(([connectionId]) => connectionId)).toEqual([
          'expired'
        ]);
        expect(await repo.getByConnectionId('expired', {})).toBeNull();
      } finally {
        for (const client of clients) client.close();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  }
);
