import { PoolConnection } from 'mysql';
import { execSQLWithParams } from './my-sql.helpers';
import { loggerContext } from '@/logger-context';
import { Logger } from '@/logging';
import {
  operationalError,
  operationalResponse,
  withOperationalContext
} from '@/operational-errors';

describe('moderation query invocation context', () => {
  it('reports a reused socket failure in the issuing invocation exactly once', async () => {
    const originalService = process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'seizeAPI';
    const envelopes: string[] = [];
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        if (String(chunk).includes('6529.ops.error.v1'))
          envelopes.push(String(chunk));
        return true;
      });
    jest.spyOn(Logger.prototype, 'error').mockImplementation(function (
      this: Logger,
      message
    ) {
      operationalError(this.name, [message], loggerContext.get()?.requestId);
    });
    let callback: (error: Error, rows: unknown[]) => void = () => {
      throw new Error('query not registered');
    };
    const connection = {
      config: {},
      query: (_query: unknown, cb: typeof callback) => {
        callback = cb;
      }
    } as unknown as PoolConnection;
    try {
      await withOperationalContext('current', () =>
        loggerContext.run({ requestId: 'current' }, async () => {
          const query = execSQLWithParams(
            'select * from content_moderation_items',
            connection,
            false,
            undefined,
            { bindInvocationContext: true }
          );
          withOperationalContext('old-socket', () =>
            loggerContext.run({ requestId: 'old-socket' }, () => {
              callback(
                Object.assign(new Error('private SQL'), {
                  code: 'ER_LOCK_DEADLOCK'
                }),
                []
              );
            })
          );
          await expect(query).rejects.toMatchObject({
            code: 'ER_LOCK_DEADLOCK'
          });
          operationalResponse({ statusCode: 503 });
        })
      );
      expect(envelopes).toHaveLength(1);
      expect(JSON.parse(envelopes[0]).correlationId).toBe('current');
      expect(envelopes[0]).not.toContain('private SQL');
      withOperationalContext('unreported', () =>
        operationalResponse({ statusCode: 503 })
      );
      expect(envelopes).toHaveLength(2);
      expect(JSON.parse(envelopes[1]).correlationId).toBe('unreported');
    } finally {
      write.mockRestore();
      jest.restoreAllMocks();
      if (originalService === undefined)
        delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      else process.env.AWS_LAMBDA_FUNCTION_NAME = originalService;
    }
  });
});
