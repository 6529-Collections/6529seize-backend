import 'reflect-metadata';
import { WS_CONNECTIONS_TABLE } from '@/constants';
import { WsConnectionRepository } from '@/api/ws/ws-connection.repository';
import { WsConnectionPurpose } from '@/entities/IWSConnection';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  CLIENT_VERSION_NONE,
  summarizeClientVersions,
  WsClientVersionsDb
} from './ws-client-versions';

const repository = new WsConnectionRepository(() => sqlExecutor, {} as never);
const versionsDb = new WsClientVersionsDb(() => sqlExecutor);

async function connect(
  connectionId: string,
  clientVersion: string | null,
  purpose: WsConnectionPurpose | null = null
) {
  await repository.save(
    {
      connection_id: connectionId,
      identity_id: `identity-${connectionId}`,
      jwt_expiry: 9_999_999_999_999,
      wave_id: null,
      purpose,
      client_version: clientVersion
    },
    [],
    {}
  );
}

describeWithSeed(
  'ws client versions (build adoption)',
  { table: WS_CONNECTIONS_TABLE, rows: [] },
  () => {
    it('stores the declared build and counts primary sockets per build', async () => {
      await connect('c1', 'abc1234');
      await connect('c2', 'abc1234');
      await connect('c3', 'def5678');
      await connect('c4', null);
      // A typing-only socket from the same app is not counted twice.
      await connect('c5', 'abc1234', WsConnectionPurpose.TYPING);

      const stored = await sqlExecutor.oneOrNull<{ client_version: string }>(
        `select client_version from ${WS_CONNECTIONS_TABLE} where connection_id = 'c1'`
      );
      expect(stored?.client_version).toBe('abc1234');

      expect(
        summarizeClientVersions(
          await versionsDb.countPrimarySocketsByClientVersion()
        )
      ).toEqual([
        { version: 'abc1234', sockets: 2 },
        { version: 'def5678', sockets: 1 },
        { version: CLIENT_VERSION_NONE, sockets: 1 }
      ]);
    });
  }
);
