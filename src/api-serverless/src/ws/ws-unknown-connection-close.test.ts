import type { APIGatewayEvent, Context } from 'aws-lambda';
import type { PoolConnection } from 'mysql';
import { DbPoolName, DbQueryOptions } from '@/db-query.options';
import { execNativeTransactionally } from '@/db/my-sql.helpers';
import { ConnectionWrapper, SqlExecutor } from '@/sql-executor';
import * as sockets from '@/api/ws/ws';
import { WsConnectionRepository } from '@/api/ws/ws-connection.repository';
import { WsMessageType } from '@/api/ws/ws-message';
import { HttpResponse } from '@smithy/protocol-http';
import { withOperationalContext } from '@/operational-errors';

const mockWarnings = jest.fn();
const mockErrors = jest.fn();
const mockTransport = jest.fn();
jest.mock('serverless-http', () => jest.fn(() => jest.fn()));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (fn: unknown) => fn
}));
jest.mock('@/logging', () => ({
  Logger: {
    get: (name: string) => ({
      info: jest.fn(),
      warn: (...args: unknown[]) => {
        if (name !== 'WS_DIAGNOSTICS') mockWarnings(...args);
      },
      debug: jest.fn(),
      error: (...args: unknown[]) => mockErrors(...args)
    })
  }
}));
jest.mock('@/api/app', () => ({
  app: {},
  ensureInitialized: async () => undefined
}));
jest.mock('@/api/ws/ws-listeners-notifier', () => ({
  wsListenersNotifier: {}
}));
jest.mock('@aws-sdk/client-apigatewaymanagementapi', () => {
  const actual = jest.requireActual('@aws-sdk/client-apigatewaymanagementapi');
  return {
    ...actual,
    ApiGatewayManagementApiClient: jest.fn(function () {
      return new actual.ApiGatewayManagementApiClient({
        endpoint: 'https://synthetic.invalid',
        region: 'us-east-1',
        maxAttempts: 1,
        credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
        requestHandler: {
          handle: (...args: unknown[]) => mockTransport(...args)
        }
      });
    })
  };
});

const { handler } = require('@/api/handler') as typeof import('@/api/handler');

const FLAG = 'WS_CLOSE_UNKNOWN_CONNECTION';
const WAVE_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Synthetic storage for one connection row. Updates answer as the mysql
 * driver does once the executor flattens its OkPacket: [fieldCount,
 * affectedRows, ...], where affectedRows counts found rows (FOUND_ROWS).
 * `reportsZero` models a driver or proxy that reports no rows for an update
 * whose row exists.
 */
class ConnectionRow extends SqlExecutor {
  present = true;
  openWaveColumn = true;
  reportsZero = false;
  updates: string[] = [];
  rowReads = 0;
  rowReadPools: (string | undefined)[] = [];
  deletes = 0;

  async execute<T>(
    sql: string,
    _params?: unknown,
    options?: DbQueryOptions
  ): Promise<T[]> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.startsWith('update ws_connections set')) {
      const column = normalized.includes('open_wave_id')
        ? 'open_wave_id'
        : 'wave_id';
      if (column === 'open_wave_id' && !this.openWaveColumn) {
        throw Object.assign(new Error('missing column'), {
          code: 'ER_BAD_FIELD_ERROR'
        });
      }
      this.updates.push(column);
      const matched = this.present && !this.reportsZero ? 1 : 0;
      return [0, matched, 0, 2, 0, '', true, 0] as T[];
    }
    if (
      normalized.startsWith('select connection_id from ws_connections') &&
      normalized.endsWith('limit 1')
    ) {
      this.rowReads++;
      this.rowReadPools.push(options?.forcePool);
      return (
        this.present ? [{ connection_id: 'synthetic-socket' }] : []
      ) as T[];
    }
    if (normalized.startsWith('select connection_id')) {
      return (
        this.present ? [{ connection_id: 'synthetic-socket' }] : []
      ) as T[];
    }
    if (normalized.startsWith('delete from')) {
      this.deletes++;
      return [];
    }
    throw new Error(`Unexpected SQL in test: ${normalized.slice(0, 60)}`);
  }

  async executeNativeQueriesInTransaction<T>(
    fn: (connection: ConnectionWrapper<unknown>) => Promise<T>
  ): Promise<T> {
    const connection = {
      beginTransaction: jest.fn(),
      commit: (callback: (error?: Error) => void) => callback(),
      rollback: jest.fn(),
      release: jest.fn()
    };
    return execNativeTransactionally(
      fn,
      connection as unknown as PoolConnection
    );
  }
}

type WaveUpdate = WsMessageType.SUBSCRIBE_TO_WAVE | WsMessageType.SET_OPEN_WAVE;
const WAVE_UPDATES: WaveUpdate[] = [
  WsMessageType.SUBSCRIBE_TO_WAVE,
  WsMessageType.SET_OPEN_WAVE
];

function fixture(type: WaveUpdate) {
  const db = new ConnectionRow();
  const repository = new WsConnectionRepository(
    () => db,
    {} as never,
    () => false
  );
  const realSockets = new sockets.AppWebSockets(repository);
  jest
    .spyOn(sockets, 'authenticateWebSocketJwtOrGetByConnectionId')
    .mockResolvedValue({
      identityId: sockets.ANON_USER_ID,
      jwtExpiry: 2000000000
    });
  jest
    .spyOn(sockets.appWebSockets, 'updateActiveWaveForConnection')
    .mockImplementation(
      realSockets.updateActiveWaveForConnection.bind(realSockets)
    );
  jest
    .spyOn(sockets.appWebSockets, 'updateOpenWaveForConnection')
    .mockImplementation(
      realSockets.updateOpenWaveForConnection.bind(realSockets)
    );
  jest
    .spyOn(sockets.appWebSockets, 'closeUnavailableConnection')
    .mockImplementation(
      realSockets.closeUnavailableConnection.bind(realSockets)
    );
  mockTransport.mockImplementation(async () => ({
    response: new HttpResponse({ statusCode: 204, headers: {}, body: '' })
  }));
  const invoke = () =>
    withOperationalContext('synthetic-request', () =>
      handler(
        {
          body: JSON.stringify({ type, wave_id: WAVE_ID }),
          requestContext: {
            routeKey: '$default',
            connectionId: 'synthetic-socket'
          }
        } as APIGatewayEvent,
        { awsRequestId: 'synthetic-request' } as Context,
        jest.fn()
      )
    );
  return { db, invoke };
}

const transportMethods = () =>
  mockTransport.mock.calls.map(
    ([request]: [{ method: string; path: string }]) =>
      `${request.method} ${request.path}`
  );

describe('wave updates on a socket whose connection row is gone', () => {
  const originalEnvironment = process.env;
  beforeEach(() => {
    process.env = {
      ...originalEnvironment,
      NODE_ENV: 'test',
      AWS_LAMBDA_FUNCTION_NAME: 'seizeAPI',
      SENTRY_ENVIRONMENT: 'api_staging'
    };
    mockTransport.mockReset();
    mockWarnings.mockReset();
    mockErrors.mockReset();
  });
  afterEach(() => {
    process.env = originalEnvironment;
    jest.restoreAllMocks();
  });

  describe.each(WAVE_UPDATES)('%s', (type) => {
    it('answers 200 and keeps the socket open with the flag off (today)', async () => {
      const { db, invoke } = fixture(type);
      db.present = false;
      expect(await invoke()).toMatchObject({ statusCode: 200 });
      expect(mockTransport).not.toHaveBeenCalled();
      expect(db.deletes).toBe(0);
    });

    it('closes the transport so the client reconnects, with the flag on', async () => {
      process.env[FLAG] = 'true';
      const { db, invoke } = fixture(type);
      db.present = false;
      expect(await invoke()).toMatchObject({ statusCode: 410 });
      expect(transportMethods()).toEqual([
        'DELETE /@connections/synthetic-socket'
      ]);
      expect(
        sockets.appWebSockets.closeUnavailableConnection
      ).toHaveBeenCalledWith('synthetic-socket');
      expect(mockWarnings).not.toHaveBeenCalled();
      expect(mockErrors).not.toHaveBeenCalled();
    });

    it('leaves a known connection alone with the flag on, without a read', async () => {
      process.env[FLAG] = 'true';
      const { db, invoke } = fixture(type);
      expect(await invoke()).toMatchObject({ statusCode: 200 });
      expect(db.updates).toHaveLength(1);
      expect(db.rowReads).toBe(0);
      expect(mockTransport).not.toHaveBeenCalled();
    });

    it('confirms a zero count by primary key and keeps a socket whose row exists', async () => {
      process.env[FLAG] = 'true';
      const { db, invoke } = fixture(type);
      db.reportsZero = true;
      expect(await invoke()).toMatchObject({ statusCode: 200 });
      expect(db.rowReads).toBe(1);
      expect(db.rowReadPools).toEqual([DbPoolName.WRITE]);
      expect(mockTransport).not.toHaveBeenCalled();
    });
  });

  it('does not close when the open-wave column is missing (no row count)', async () => {
    process.env[FLAG] = 'true';
    const { db, invoke } = fixture(WsMessageType.SET_OPEN_WAVE);
    db.present = false;
    db.openWaveColumn = false;
    expect(await invoke()).toMatchObject({ statusCode: 200 });
    expect(mockTransport).not.toHaveBeenCalled();
  });

  it('keeps a database failure a plain 500 without a control warning', async () => {
    process.env[FLAG] = 'true';
    const { db, invoke } = fixture(WsMessageType.SUBSCRIBE_TO_WAVE);
    jest
      .spyOn(db, 'execute')
      .mockRejectedValue(
        Object.assign(new Error('lock'), { code: 'ER_LOCK_WAIT_TIMEOUT' })
      );
    expect(await invoke()).toMatchObject({ statusCode: 500 });
    expect(mockTransport).not.toHaveBeenCalled();
    expect(mockWarnings).not.toHaveBeenCalled();
  });
});
