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
import {
  AppWebSockets,
  appWebSockets,
  SocketNotAvailableException
} from '@/api/ws/ws';
import { WsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import { WsMessageType } from '@/api/ws/ws-message';
import { recoverUnavailableWebSocket } from '@/api/ws/ws-control-failure';
import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { WS_CONNECTIONS_TABLE, XTDH_STATS_META_TABLE } from '@/constants';

// WS_CLOSE_UNKNOWN_CONNECTION against MySQL and real local sockets: a socket
// whose row was deleted is closed on its next wave update, and the client's
// reconnect gets live frames again.

const FLAG = 'WS_CLOSE_UNKNOWN_CONNECTION';
const member = anIdentity({ level_raw: 0, tdh: 20 });
const author = anIdentity({ level_raw: 0, tdh: 20 });
const publicWave = aWave({ visibility_group_id: null });

describeWithSeed(
  'WebSocket connections whose row is gone',
  [
    withIdentities([member, author]),
    withWaves([publicWave]),
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
    const originalFlag = process.env[FLAG];
    let server: WebSocketServer;
    let port: number;
    let clients: WebSocket[];

    beforeEach(async () => {
      await sqlExecutor.execute(`delete from ${WS_CONNECTIONS_TABLE}`);
      process.env[FLAG] = 'true';
      clients = [];
      server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await once(server, 'listening');
      const address = server.address();
      if (typeof address === 'string' || address === null)
        throw new Error('Expected a TCP address');
      port = address.port;
    });
    afterEach(async () => {
      if (originalFlag === undefined) delete process.env[FLAG];
      else process.env[FLAG] = originalFlag;
      for (const client of clients) client.close();
      await new Promise((resolve) => server.close(resolve));
      jest.restoreAllMocks();
    });

    /**
     * The handler's recovery closes through the module's shared instance;
     * route it to this test's instance, as the handler tests do.
     */
    function routeRecovery(sockets: AppWebSockets) {
      jest
        .spyOn(appWebSockets, 'closeUnavailableConnection')
        .mockImplementation(sockets.closeUnavailableConnection.bind(sockets));
    }

    /** Opens a client socket and registers it as `connectionId`. */
    async function connect(sockets: AppWebSockets, connectionId: string) {
      const connected = once(server, 'connection');
      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      const frames: string[] = [];
      client.on('message', (data) => frames.push(data.toString()));
      clients.push(client);
      await once(client, 'open');
      const [socket] = (await connected) as [WebSocket];
      await sockets.register({
        identityId: member.profile_id!,
        connectionId,
        jwtExpiry: 4102444800,
        ws: socket
      });
      return { client, frames };
    }

    async function postDrop(sockets: AppWebSockets, id: string) {
      const notifier = new WsListenersNotifier(sockets, repo, {
        getViewerContextsForDrop: async () => ({})
      });
      await notifier.notifyAboutDropUpdate(
        Object.assign(new ApiDrop(), {
          id,
          serial_no: 7,
          drop_type: ApiDropType.Chat,
          author: { id: author.profile_id, subscribed_actions: [] },
          wave: { id: publicWave.id, visibility_group_id: null },
          parts: [{ content: 'synthetic' }],
          reactions: []
        }),
        {}
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const dropFrames = (frames: string[]) =>
      frames.filter(
        (frame) => JSON.parse(frame).type === WsMessageType.DROP_UPDATE
      );

    it('counts matched rows on MySQL, including an update that changes nothing', async () => {
      await sqlExecutor.execute(
        `insert into ${WS_CONNECTIONS_TABLE} (connection_id, identity_id, jwt_expiry) values ('c1', :identity, 4102444800)`,
        { identity: member.profile_id }
      );
      const update = { connectionId: 'c1', waveId: publicWave.id };
      expect(await repo.updateWaveId(update, {})).toBe(1);
      expect(await repo.updateWaveId(update, {})).toBe(1);
      expect(await repo.updateOpenWaveId(update, {})).toBe(1);
      expect(await repo.updateOpenWaveId(update, {})).toBe(1);
      const gone = { connectionId: 'gone', waveId: publicWave.id };
      expect(await repo.updateWaveId(gone, {})).toBe(0);
      expect(await repo.updateOpenWaveId(gone, {})).toBe(0);
    });

    it('closes a socket whose row was deleted, and its reconnect gets the next drop', async () => {
      const sockets = new AppWebSockets(repo);
      routeRecovery(sockets);
      const first = await connect(sockets, 'tab-before');
      await sockets.updateOpenWaveForConnection(
        { connectionId: 'tab-before', openWaveId: publicWave.id },
        {}
      );
      await postDrop(sockets, 'drop-before-wipe');
      expect(dropFrames(first.frames)).toHaveLength(1);

      // The table is emptied while the socket stays open.
      await sqlExecutor.execute(`delete from ${WS_CONNECTIONS_TABLE}`);
      await postDrop(sockets, 'drop-during-wipe');
      expect(dropFrames(first.frames)).toHaveLength(1);

      // Its next wave update finds no row; the handler's recovery closes it.
      const closed = once(first.client, 'close');
      const error = await sockets
        .updateOpenWaveForConnection(
          { connectionId: 'tab-before', openWaveId: publicWave.id },
          {}
        )
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SocketNotAvailableException);
      expect(
        await recoverUnavailableWebSocket(
          error,
          WsMessageType.SET_OPEN_WAVE,
          'tab-before'
        )
      ).toBe(true);
      await closed;

      // The client reconnects and registers again; delivery resumes.
      const second = await connect(sockets, 'tab-after');
      await sockets.updateOpenWaveForConnection(
        { connectionId: 'tab-after', openWaveId: publicWave.id },
        {}
      );
      await postDrop(sockets, 'drop-after-reconnect');
      expect(dropFrames(second.frames)).toHaveLength(1);
      expect(dropFrames(first.frames)).toHaveLength(1);
    });

    it('keeps today behaviour with the flag off: the update resolves and the socket stays open', async () => {
      delete process.env[FLAG];
      const sockets = new AppWebSockets(repo);
      const { client } = await connect(sockets, 'tab-flag-off');
      await sqlExecutor.execute(`delete from ${WS_CONNECTIONS_TABLE}`);
      await expect(
        sockets.updateActiveWaveForConnection(
          { connectionId: 'tab-flag-off', activeWaveId: publicWave.id },
          {}
        )
      ).resolves.toBeUndefined();
      expect(client.readyState).toBe(WebSocket.OPEN);
    });

    it('races updates with the row deletion: each update succeeds or closes, nothing else', async () => {
      const sockets = new AppWebSockets(repo);
      routeRecovery(sockets);
      await connect(sockets, 'tab-race');
      const updates = Array.from({ length: 6 }, (_, i) =>
        (i % 2
          ? sockets.updateActiveWaveForConnection(
              { connectionId: 'tab-race', activeWaveId: publicWave.id },
              {}
            )
          : sockets.updateOpenWaveForConnection(
              { connectionId: 'tab-race', openWaveId: publicWave.id },
              {}
            )
        ).then(
          () => 'updated',
          (e: unknown) =>
            e instanceof SocketNotAvailableException ? 'unknown' : String(e)
        )
      );
      const deletion = repo.deleteByConnectionId('tab-race', {});
      const outcomes = await Promise.all(updates);
      await deletion;
      expect(
        outcomes.every((outcome) => ['updated', 'unknown'].includes(outcome))
      ).toBe(true);
      // After the deletion, every update closes; closing twice is harmless.
      const afterDeletion = {
        [WsMessageType.SET_OPEN_WAVE]: () =>
          sockets.updateOpenWaveForConnection(
            { connectionId: 'tab-race', openWaveId: null },
            {}
          ),
        [WsMessageType.SUBSCRIBE_TO_WAVE]: () =>
          sockets.updateActiveWaveForConnection(
            { connectionId: 'tab-race', activeWaveId: null },
            {}
          )
      };
      for (const type of [
        WsMessageType.SET_OPEN_WAVE,
        WsMessageType.SUBSCRIBE_TO_WAVE
      ] as const) {
        const error = await afterDeletion[type]().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SocketNotAvailableException);
        expect(await recoverUnavailableWebSocket(error, type, 'tab-race')).toBe(
          true
        );
      }
    });
  }
);
