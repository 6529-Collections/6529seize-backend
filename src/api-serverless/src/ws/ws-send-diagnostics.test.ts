import { describeWebSocketSendFailure } from './ws-send-diagnostics';
import { operationalError } from '@/operational-errors';

describe('bounded WebSocket send diagnostics', () => {
  it.each([
    'DROP_UPDATE',
    'DROP_UPDATE_REF',
    'DROP_DELETE',
    'DROP_RATING_UPDATE',
    'DROP_REACTION_UPDATE',
    'USER_IS_TYPING',
    'AUTHENTICATED',
    'AUTHENTICATION_FAILED',
    'NOTIFICATION_IDENTITIES_SYNCED',
    'IDENTITY_NOTIFICATIONS_CHANGED',
    'DM_UNREAD_STATE_CHANGED',
    'MEDIA_LINK_UPDATED',
    'ATTACHMENT_STATUS_UPDATE'
  ])('retains only the allowlisted outbound type %s', (type) => {
    const result = describeWebSocketSendFailure(
      JSON.stringify({ type, data: { private: 'secret-frame' } }),
      {
        name: 'LimitExceededException',
        message: 'secret-error',
        connectionId: 'secret-id',
        $metadata: {
          httpStatusCode: 429,
          attempts: 3,
          totalRetryDelay: 707,
          requestId: 'secret-request'
        }
      }
    );
    expect(result).toEqual({
      unavailable: false,
      diagnostic: {
        code: 'WS_OUTBOUND_SEND_FAILED',
        frame_type: type,
        error_category: 'THROTTLED',
        http_status: 429,
        sdk_attempts: 3,
        sdk_retry_delay_ms: 707
      }
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it.each([
    undefined,
    null,
    123,
    {},
    '',
    '{broken',
    'null',
    '[]',
    '"AUTHENTICATED"',
    '{"type":"private-unknown-type"}',
    '{"type":"AUTHENTICATE"}',
    '{"type":"SYNC_NOTIFICATION_IDENTITIES"}',
    '{"type":"SUBSCRIBE_TO_WAVE"}',
    JSON.stringify({ type: 'DROP_UPDATE', data: 'x'.repeat(128 * 1024) })
  ])('bounds unknown, invalid and oversized frames %#', (message) => {
    expect(describeWebSocketSendFailure(message, undefined).diagnostic).toEqual(
      {
        code: 'WS_OUTBOUND_SEND_FAILED',
        frame_type: 'OTHER',
        error_category: 'OTHER',
        http_status: null,
        sdk_attempts: null,
        sdk_retry_delay_ms: null
      }
    );
  });

  it.each([
    undefined,
    null,
    'private-error',
    7,
    [],
    {},
    { $metadata: null },
    {
      name: 'private-name',
      code: 'private-code',
      $metadata: { httpStatusCode: '429', attempts: '3', totalRetryDelay: '10' }
    }
  ])(
    'handles nonstandard errors without coercion or dynamic labels %#',
    (error) => {
      expect(describeWebSocketSendFailure('{}', error)).toEqual({
        unavailable: false,
        diagnostic: {
          code: 'WS_OUTBOUND_SEND_FAILED',
          frame_type: 'OTHER',
          error_category: 'OTHER',
          http_status: null,
          sdk_attempts: null,
          sdk_retry_delay_ms: null
        }
      });
    }
  );

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid numeric metadata %s',
    (value) => {
      const result = describeWebSocketSendFailure('{}', {
        $metadata: {
          httpStatusCode: value,
          attempts: value,
          totalRetryDelay: value
        }
      });
      expect(result.diagnostic.http_status).toBeNull();
      expect(result.diagnostic.sdk_attempts).toBeNull();
      expect(result.diagnostic.sdk_retry_delay_ms).toBeNull();
    }
  );

  it('keeps actual zero delay and rejects impossible status and zero attempts', () => {
    expect(
      describeWebSocketSendFailure('{}', {
        $metadata: {
          httpStatusCode: 600,
          attempts: 0,
          totalRetryDelay: 0
        }
      }).diagnostic
    ).toMatchObject({
      http_status: null,
      sdk_attempts: null,
      sdk_retry_delay_ms: 0
    });
  });

  it('does not throw for accessors or revoked proxies', () => {
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error('private getter');
        }
      }
    );
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    for (const error of [throwing, revocable.proxy, { $metadata: throwing }]) {
      expect(() => describeWebSocketSendFailure('{}', error)).not.toThrow();
      expect(
        describeWebSocketSendFailure('{}', error).diagnostic.sdk_attempts
      ).toBeNull();
    }
  });

  it.each([
    { name: 'GoneException' },
    { $metadata: { httpStatusCode: 410 } },
    { name: 'BadRequestException', message: 'Invalid connectionId: private-id' }
  ])('preserves unavailable-connection classification %#', (error) => {
    expect(describeWebSocketSendFailure('{}', error).unavailable).toBe(true);
  });

  it.each([
    [{ name: 'LimitExceededException' }, 'THROTTLED'],
    [{ name: 'ForbiddenException' }, 'FORBIDDEN'],
    [{ name: 'PayloadTooLargeException' }, 'PAYLOAD_TOO_LARGE'],
    [
      { name: 'BadRequestException', message: 'other bad request' },
      'INVALID_REQUEST'
    ],
    [{ $metadata: { httpStatusCode: 503 } }, 'SERVICE_ERROR'],
    [{ code: 'ECONNRESET' }, 'TRANSPORT_ERROR']
  ])('classifies final errors with fixed labels %#', (error, category) => {
    const result = describeWebSocketSendFailure('{}', error);
    expect(result.unavailable).toBe(false);
    expect(result.diagnostic.error_category).toBe(category);
  });

  it('preserves the operational error fingerprint and exports neither old nor new message content', () => {
    const original = process.env.AWS_LAMBDA_FUNCTION_NAME;
    const output = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'seizeAPI';
    try {
      operationalError('ApiGatewayManagementApiClient2', [
        'old private message'
      ]);
      operationalError('ApiGatewayManagementApiClient2', [
        describeWebSocketSendFailure(
          '{"type":"USER_IS_TYPING","data":"private"}',
          { name: 'LimitExceededException' }
        ).diagnostic
      ]);
      expect(output).toHaveBeenCalledTimes(2);
      const records = output.mock.calls.map(([value]) =>
        JSON.parse(String(value))
      );
      expect(records[0].fingerprint).toBe(records[1].fingerprint);
      expect(records[0].code).toBe(records[1].code);
      expect(JSON.stringify(records)).not.toMatch(
        /private|frame_type|USER_IS_TYPING/
      );
    } finally {
      if (original === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
      else process.env.AWS_LAMBDA_FUNCTION_NAME = original;
      output.mockRestore();
    }
  });
});
