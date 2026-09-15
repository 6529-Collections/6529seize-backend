import { Logger } from '@/logging';
import { withOperationalContext } from '@/operational-errors';
import { transports } from 'winston';
import {
  createPushSendDiagnostic,
  reportPushImageRetry,
  reportPushSendDiagnostic
} from './push-send-diagnostics';

const privateText = 'PRIVATE_TOKEN_URL_REQUEST_CREDENTIAL_MESSAGE';

describe('push send diagnostics', () => {
  const originalEnvironment = process.env;
  let output: jest.SpyInstance;
  let localOutput: string[];

  beforeEach(() => {
    process.env = {
      ...originalEnvironment,
      AWS_LAMBDA_FUNCTION_NAME: 'pushNotificationsHandler',
      OPS_ENVIRONMENT: 'staging'
    };
    output = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    localOutput = [];
    jest
      .spyOn(transports.Console.prototype, 'log')
      .mockImplementation((info, callback) => {
        localOutput.push(
          String((info as Record<symbol, unknown>)[Symbol.for('message')])
        );
        if (typeof callback === 'function') callback();
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnvironment;
  });

  function envelopes() {
    return output.mock.calls.flatMap(([value]) => {
      try {
        const parsed = JSON.parse(String(value));
        return parsed._type === '6529.ops.error.v1' ? [parsed] : [];
      } catch {
        return [];
      }
    });
  }

  it.each([
    ['mismatched-credential', 'FCM_MISMATCHED_CREDENTIAL'],
    ['authentication-error', 'FCM_AUTHENTICATION_ERROR'],
    ['server-unavailable', 'FCM_SERVER_UNAVAILABLE'],
    ['internal-error', 'FCM_INTERNAL_ERROR'],
    ['message-rate-exceeded', 'FCM_MESSAGE_RATE_EXCEEDED'],
    ['device-message-rate-exceeded', 'FCM_DEVICE_MESSAGE_RATE_EXCEEDED'],
    ['invalid-payload', 'FCM_INVALID_PAYLOAD'],
    ['payload-size-limit-exceeded', 'FCM_PAYLOAD_SIZE_LIMIT_EXCEEDED'],
    ['invalid-registration-token', 'FCM_INVALID_REGISTRATION_TOKEN'],
    ['registration-token-not-registered', 'FCM_REGISTRATION_NOT_REGISTERED']
  ])(
    'projects the finite %s code without retaining provider data',
    (raw, code) => {
      const provider = Object.assign(new Error(privateText), {
        code: `messaging/${raw}`,
        cause: { request: privateText },
        token: privateText,
        toJSON: () => privateText
      });
      const diagnostic = createPushSendDiagnostic(provider, 'sdk_response');

      expect(diagnostic).toBeInstanceOf(Error);
      expect(diagnostic).not.toBe(provider);
      expect(diagnostic).toMatchObject({
        code,
        stage: 'sdk_response',
        name: `PushSend.sdk_response.${code}`,
        message: `Push notification failed [sdk_response/${code}]`
      });
      expect(diagnostic.stack).toBeUndefined();
      expect(
        Object.getOwnPropertyNames(diagnostic).sort((a, b) =>
          a.localeCompare(b)
        )
      ).toEqual(['code', 'message', 'name', 'stage']);
      withOperationalContext('request-1', () =>
        reportPushSendDiagnostic(diagnostic)
      );
      expect(envelopes()).toHaveLength(1);
      expect(envelopes()[0].code).toBe('APPLICATION_ERROR');
      const localLogs = localOutput.join('');
      expect(localLogs).toContain(
        `Push notification failed [sdk_response/${code}]`
      );
      expect(
        output.mock.calls.map(([value]) => String(value)).join('')
      ).not.toContain(privateText);
      expect(localLogs).not.toContain(privateText);
    }
  );

  it.each([
    null,
    undefined,
    privateText,
    10,
    { code: privateText },
    { code: ['messaging/mismatched-credential'] },
    { code: 'constructor' },
    { error: { code: 'messaging/mismatched-credential' } },
    { cause: { code: 'messaging/mismatched-credential' } }
  ])('keeps unsupported values and wrappers unknown (%#)', (value) => {
    expect(createPushSendDiagnostic(value, 'prepare').code).toBe('UNKNOWN');
  });

  it('contains throwing getters and proxy traps without reading other fields', () => {
    const provider = {
      get code(): string {
        throw new Error(privateText);
      },
      get message(): string {
        throw new Error('message accessed');
      }
    };
    const proxy = new Proxy(
      {},
      {
        get: () => {
          throw new Error(privateText);
        }
      }
    );
    expect(createPushSendDiagnostic(provider, 'sdk_response').code).toBe(
      'UNKNOWN'
    );
    expect(createPushSendDiagnostic(proxy, 'sdk_response').code).toBe(
      'UNKNOWN'
    );
    expect(output).not.toHaveBeenCalled();
  });

  it('separates local preparation, provider categories and distinct attempts', () => {
    const provider = { code: 'messaging/payload-size-limit-exceeded' };
    const local = createPushSendDiagnostic(provider, 'prepare');
    const remote = createPushSendDiagnostic(provider, 'sdk_response');
    const nextAttempt = createPushSendDiagnostic(provider, 'sdk_response');
    withOperationalContext('request-1', () => {
      reportPushSendDiagnostic(local);
      reportPushSendDiagnostic(local);
      reportPushSendDiagnostic(remote);
      reportPushSendDiagnostic(nextAttempt);
    });
    const rows = envelopes();
    expect(rows).toHaveLength(3);
    expect(rows[0].fingerprint).not.toBe(rows[1].fingerprint);
    expect(rows[1].fingerprint).toBe(rows[2].fingerprint);
    withOperationalContext('request-2', () => reportPushSendDiagnostic(remote));
    expect(envelopes()).toHaveLength(4);
  });

  it('does not let error or retry-info logging failures escape', () => {
    const logger = Logger.get('PUSH_NOTIFICATIONS_HANDLER_SEND');
    jest.spyOn(logger, 'error').mockImplementation(() => {
      throw new Error(privateText);
    });
    jest.spyOn(logger, 'info').mockImplementation(() => {
      throw new Error(privateText);
    });
    expect(() =>
      reportPushSendDiagnostic(createPushSendDiagnostic(null, 'prepare'))
    ).not.toThrow();
    expect(() => reportPushImageRetry()).not.toThrow();
  });
});
