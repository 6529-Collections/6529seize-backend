import type { PoolConnection } from 'mysql';
import { execSQLWithParams } from '@/db/my-sql.helpers';
import { loggerContext } from '@/logger-context';
import { Logger } from '@/logging';
import {
  operationalError,
  operationalResponse,
  withOperationalContext
} from '@/operational-errors';
import { SqlExecutor } from '@/sql-executor';
import { WsConnectionRepository } from './ws-connection.repository';
import {
  setWebSocketDiagnosticOperation,
  withWebSocketOperationDiagnostics
} from './ws-operation-diagnostics';

it('attributes a WebSocket SQL callback from a reused socket to its issuing invocation', async () => {
  const originalService = process.env.AWS_LAMBDA_FUNCTION_NAME;
  process.env.AWS_LAMBDA_FUNCTION_NAME = 'seizeAPI';
  const envelopes: { correlationId: string }[] = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    if (String(chunk).includes('6529.ops.error.v1'))
      envelopes.push(JSON.parse(String(chunk)));
    return true;
  });
  jest.spyOn(Logger.prototype, 'error').mockImplementation(function (
    this: Logger,
    message
  ) {
    operationalError(this.name, [message], loggerContext.get()?.requestId);
  });
  jest.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  let callback: (error: Error, rows: unknown[]) => void = () => {
    throw new Error('query not registered');
  };
  const connection = {
    config: {},
    query: (_sql: unknown, cb: typeof callback) => {
      callback = cb;
    }
  } as unknown as PoolConnection;
  const execute: SqlExecutor['execute'] = (sql, params, options) =>
    execSQLWithParams(sql, connection, false, params, options);
  const repository = new WsConnectionRepository(
    () =>
      ({
        execute,
        executeNativeQueriesInTransaction: (
          action: (connection: { connection: PoolConnection }) => Promise<void>
        ) => action({ connection })
      }) as unknown as SqlExecutor,
    {} as never,
    () => false
  );
  try {
    const work = withOperationalContext('current', () =>
      withWebSocketOperationDiagnostics(
        {
          routeKey: '$default',
          connectionId: 'synthetic-socket',
          lambdaRequestId: 'current'
        },
        async () => {
          setWebSocketDiagnosticOperation('SYNC_NOTIFICATION_IDENTITIES');
          await expect(
            repository.replaceNotificationSubscriptions(
              'synthetic-socket',
              [],
              {}
            )
          ).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' });
          return operationalResponse({ statusCode: 500 });
        }
      )
    );
    withOperationalContext('earlier', () =>
      loggerContext.run({ requestId: 'earlier' }, () =>
        callback(
          Object.assign(new Error('synthetic failure'), {
            code: 'ER_LOCK_WAIT_TIMEOUT'
          }),
          []
        )
      )
    );
    await expect(work).resolves.toMatchObject({ statusCode: 500 });
    expect(envelopes.map((entry) => entry.correlationId)).toEqual(['current']);
    withOperationalContext('unreported', () =>
      operationalResponse({ statusCode: 500 })
    );
    expect(envelopes.map((entry) => entry.correlationId)).toEqual([
      'current',
      'unreported'
    ]);
  } finally {
    jest.restoreAllMocks();
    if (originalService === undefined)
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    else process.env.AWS_LAMBDA_FUNCTION_NAME = originalService;
  }
});
