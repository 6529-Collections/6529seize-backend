import * as mysql from 'mysql';
import { execSQLWithConnection, execSQLWithParams } from './my-sql.helpers';
import { loggerContext } from '@/logger-context';
import { Logger } from '@/logging';
import {
  operationalError,
  operationalResponse,
  withOperationalContext
} from '@/operational-errors';

describe('moderation errors on a reused MySQL socket', () => {
  it.each([false, true])(
    'bindInvocationContext=%s',
    async (bindInvocationContext) => {
      const originalService = process.env.AWS_LAMBDA_FUNCTION_NAME;
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'seizeAPI';
      const envelopes: { correlationId: string }[] = [];
      const timings: (string | undefined)[] = [];
      const pool = mysql.createPool({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT),
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
        connectionLimit: 1
      });
      const acquire = () =>
        new Promise<mysql.PoolConnection>((resolve, reject) => {
          pool.getConnection((error, connection) =>
            error ? reject(error) : resolve(connection)
          );
        });
      jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        if (String(chunk).includes('6529.ops.error.v1'))
          envelopes.push(JSON.parse(String(chunk)));
        return true;
      });
      jest.spyOn(Logger.prototype, 'error').mockImplementation(function (
        this: Logger,
        message
      ) {
        expect(String(message)).not.toContain('missing_private_column');
        operationalError(this.name, [message], loggerContext.get()?.requestId);
      });
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
        timings.push(loggerContext.get()?.requestId);
      });
      let firstConnection: mysql.PoolConnection | undefined;
      try {
        // Establish the physical socket inside the earlier invocation, then release
        // it. The second request really reuses mysql's socket/parser callbacks.
        await withOperationalContext('earlier', () =>
          loggerContext.run({ requestId: 'earlier' }, async () => {
            const connection = await acquire();
            firstConnection = connection;
            try {
              await execSQLWithParams('select 1', connection, false);
            } finally {
              connection.release();
            }
          })
        );
        await withOperationalContext('current', () =>
          loggerContext.run({ requestId: 'current' }, async () => {
            const connection = await acquire();
            expect(connection).toBe(firstConnection);
            try {
              await expect(
                execSQLWithConnection(
                  'select missing_private_column from content_moderation_items',
                  { connection },
                  undefined,
                  { bindInvocationContext }
                )
              ).rejects.toMatchObject({ code: 'ER_BAD_FIELD_ERROR' });
              operationalResponse({ statusCode: 503 });
            } finally {
              connection.release();
            }
          })
        );
        expect(timings).toEqual(['current']);
        expect(envelopes.map((event) => event.correlationId)).toEqual(
          bindInvocationContext ? ['current'] : ['earlier', 'current']
        );
        withOperationalContext('unreported', () =>
          operationalResponse({ statusCode: 503 })
        );
        expect(envelopes.at(-1)?.correlationId).toBe('unreported');
      } finally {
        await new Promise<void>((resolve, reject) =>
          pool.end((error) => (error ? reject(error) : resolve()))
        );
        jest.restoreAllMocks();
        if (originalService === undefined)
          delete process.env.AWS_LAMBDA_FUNCTION_NAME;
        else process.env.AWS_LAMBDA_FUNCTION_NAME = originalService;
      }
    }
  );
});
