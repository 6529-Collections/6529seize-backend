import { Logger } from '@/logging';
import { loggerContext } from '@/logger-context';
import {
  recordWebSocketAcknowledgement,
  setWebSocketDiagnosticOperation,
  withWebSocketOperationDiagnostics
} from './ws-operation-diagnostics';
import {
  recordWebSocketDatabaseSession,
  recordWebSocketSqlPhase,
  recordWebSocketTransactionIsolation,
  WsTransactionDiagnostics
} from './ws-transaction-diagnostics';

const input = {
  routeKey: '$default',
  connectionId: 'PRIVATE_SOCKET_CANARY',
  lambdaRequestId: 'current-lambda',
  gatewayRequestId: 'current-gateway'
};
const deadlock = Object.assign(new Error('PRIVATE_SQL_CANARY'), {
  code: 'ER_LOCK_DEADLOCK',
  errno: 1213,
  sqlState: '40001',
  sql: 'PRIVATE_SQL_CANARY',
  token: 'PRIVATE_JWT_CANARY'
});

describe('WebSocket operation and transaction diagnostics', () => {
  let records: Record<string, unknown>[];
  beforeEach(() => {
    records = [];
    for (const level of ['info', 'warn'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          const details = args[1];
          if (details && typeof details === 'object') {
            records.push(details as Record<string, unknown>);
          }
        });
    }
  });
  afterEach(() => jest.restoreAllMocks());

  it('links a deadlocked attempt, committed retry and acknowledgement without sensitive values', async () => {
    await loggerContext.run(
      { requestId: 'earlier-lambda', jwtSub: 'PRIVATE_IDENTITY_CANARY' },
      () =>
        withWebSocketOperationDiagnostics(input, async () => {
          expect(loggerContext.get()).toEqual({ requestId: 'current-lambda' });
          setWebSocketDiagnosticOperation('AUTHENTICATE');
          const trace = new WsTransactionDiagnostics(
            'AUTHENTICATE',
            input.connectionId,
            'repository',
            1
          );
          await trace.runAttempt(1, async () => {
            recordWebSocketTransactionIsolation('READ-COMMITTED');
            recordWebSocketDatabaseSession({
              diagnostic_session_id: 101,
              diagnostic_isolation: 'REPEATABLE-READ',
              identity_id: 'PRIVATE_IDENTITY_CANARY'
            });
            recordWebSocketSqlPhase('insert_subscriptions');
          });
          trace.failed(deadlock, true);
          await trace.runAttempt(2, async () => {
            recordWebSocketTransactionIsolation('READ-COMMITTED');
            recordWebSocketDatabaseSession({
              diagnostic_session_id: 202,
              diagnostic_isolation: 'REPEATABLE-READ'
            });
            recordWebSocketSqlPhase('commit');
          });
          trace.completed();
          recordWebSocketAcknowledgement(
            input.connectionId,
            '{"type":"AUTHENTICATED","token":"PRIVATE_JWT_CANARY"}',
            'accepted'
          );
          return { statusCode: 200 };
        })
    );
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      event: 'ws_transaction',
      attempt: 1,
      phase: 'insert_subscriptions',
      db_session_id: 101,
      isolation: 'READ-COMMITTED',
      session_isolation: 'REPEATABLE-READ',
      mysql_code: 'ER_LOCK_DEADLOCK',
      mysql_errno: 1213,
      mysql_sqlstate: '40001',
      outcome: 'retry_pending',
      transaction_outcome: 'rolled_back_by_mysql'
    });
    expect(records[1]).toMatchObject({
      attempt: 2,
      phase: 'commit',
      db_session_id: 202,
      outcome: 'committed',
      recovered: true
    });
    expect(records[2]).toMatchObject({
      event: 'ws_operation',
      outcome: 'completed',
      response_status: 200,
      acknowledgement: 'accepted',
      acknowledgement_type: 'AUTHENTICATED'
    });
    expect(new Set(records.map((entry) => entry.operation_id)).size).toBe(1);
    expect(records[0].mutation_id).toBe(records[1].mutation_id);
    for (const entry of records) {
      expect(entry).toMatchObject({
        lambda_request_id: 'current-lambda',
        gateway_request_id: 'current-gateway',
        request_id: 'current-lambda',
        socket_hash: expect.stringMatching(/^[a-f0-9]{64}$/)
      });
    }
    expect(JSON.stringify(records)).not.toContain('PRIVATE_');
    expect(loggerContext.get()).toBeUndefined();
  });

  it('does not claim commit or local retry authority for caller-owned transactions', async () => {
    const trace = new WsTransactionDiagnostics(
      'AUTHENTICATE',
      input.connectionId,
      'caller'
    );
    await trace.runAttempt(1, async () => {
      recordWebSocketSqlPhase('insert_subscriptions');
      recordWebSocketDatabaseSession({
        diagnostic_session_id: 303,
        diagnostic_isolation: 'REPEATABLE-READ'
      });
    });
    trace.completed();
    trace.failed(deadlock, false);
    expect(records[0]).toMatchObject({
      outcome: 'statements_completed',
      transaction_owner: 'caller',
      isolation: null,
      session_isolation: 'REPEATABLE-READ'
    });
    expect(records[1]).toMatchObject({
      outcome: 'failed',
      transaction_outcome: 'unknown',
      retry_pending: false,
      retries_exhausted: false,
      max_attempts: 1
    });
  });

  it('distinguishes exhausted retries and ambiguous commit failures', async () => {
    const trace = new WsTransactionDiagnostics(
      'AUTHENTICATE',
      input.connectionId,
      'repository'
    );
    await trace.runAttempt(3, async () =>
      recordWebSocketSqlPhase('insert_subscriptions')
    );
    trace.failed(deadlock, false);
    expect(records[0]).toMatchObject({
      retries_exhausted: true,
      attempt: 3,
      outcome: 'failed'
    });
    await trace.runAttempt(1, async () => recordWebSocketSqlPhase('commit'));
    trace.failed(
      { code: 'PROTOCOL_CONNECTION_LOST', message: 'PRIVATE_MESSAGE' },
      false
    );
    expect(records[1]).toMatchObject({
      phase: 'commit',
      transaction_outcome: 'unknown',
      retries_exhausted: false,
      db_session_id: null
    });
  });

  it('keeps concurrent requests and sends to other sockets separate', async () => {
    let resume!: () => void;
    const wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const first = withWebSocketOperationDiagnostics(input, async () => {
      setWebSocketDiagnosticOperation('AUTHENTICATE');
      await wait;
      recordWebSocketAcknowledgement(
        'other-socket',
        '{"type":"AUTHENTICATED"}',
        'accepted'
      );
      return { statusCode: 200 };
    });
    await withWebSocketOperationDiagnostics(
      {
        ...input,
        connectionId: 'other-socket',
        lambdaRequestId: 'other-lambda'
      },
      async () => {
        setWebSocketDiagnosticOperation('SYNC_NOTIFICATION_IDENTITIES');
        recordWebSocketAcknowledgement(
          'other-socket',
          '{"type":"NOTIFICATION_IDENTITIES_SYNCED"}',
          'failed'
        );
        return { statusCode: 200 };
      }
    );
    resume();
    await first;
    expect(records[0]).toMatchObject({
      lambda_request_id: 'other-lambda',
      acknowledgement: 'failed'
    });
    expect(records[1]).toMatchObject({
      lambda_request_id: 'current-lambda',
      acknowledgement: 'not_attempted'
    });
    expect(records[0].operation_id).not.toBe(records[1].operation_id);
  });

  it('preserves return values and original failures when diagnostics fail', async () => {
    jest.spyOn(Logger.prototype, 'info').mockImplementation(() => {
      throw new Error('log unavailable');
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      throw new Error('log unavailable');
    });
    const result = { statusCode: 200, body: 'unchanged' };
    await expect(
      withWebSocketOperationDiagnostics(
        { ...input, routeKey: '$connect' },
        async () => result
      )
    ).resolves.toBe(result);
    await expect(
      withWebSocketOperationDiagnostics(
        { ...input, routeKey: '$disconnect' },
        async () => {
          throw deadlock;
        }
      )
    ).rejects.toBe(deadlock);
  });

  it('ignores unknown message types and hostile error metadata without retaining payloads', async () => {
    await withWebSocketOperationDiagnostics(input, async () => {
      setWebSocketDiagnosticOperation('PRIVATE_UNKNOWN_CANARY');
      recordWebSocketAcknowledgement(
        input.connectionId,
        '{"type":"PRIVATE_TYPE_CANARY"}',
        'failed'
      );
      return { statusCode: 200 };
    });
    expect(records).toEqual([]);
    const trace = new WsTransactionDiagnostics(
      'CLEANUP',
      undefined,
      'autocommit'
    );
    trace.failed(
      new Proxy(
        {},
        {
          get() {
            throw new Error('PRIVATE_ERROR_CANARY');
          }
        }
      ),
      false
    );
    expect(records[0]).toMatchObject({
      mysql_code: 'OTHER',
      mysql_errno: null,
      mysql_sqlstate: null
    });
    expect(JSON.stringify(records)).not.toContain('PRIVATE_');
  });
});
