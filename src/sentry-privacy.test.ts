import { sanitizeSentryEvent } from './sentry-privacy';
import type { LambdaSentryEvent } from './sentry.context';

const sensitiveRequest = {
  method: 'POST',
  url: 'https://name:secret@api.example.com/api/drops?reason=private#private',
  data: { moderation: 'private evidence' },
  query_string: 'reason=private',
  headers: { authorization: 'private token' },
  cookies: { session: 'private cookie' },
  env: { PRIVATE: 'private environment' }
};

describe('Sentry telemetry privacy', () => {
  it('removes SDK-shaped request payload, credentials and user on ordinary content routes without losing error diagnosis', () => {
    const event: LambdaSentryEvent = {
      request: sensitiveRequest,
      user: { id: 'private user' },
      exception: {
        values: [
          {
            type: 'Error',
            value: 'Database unavailable',
            stacktrace: { frames: [{ filename: 'db.ts', lineno: 12 }] }
          }
        ]
      }
    };
    const sanitized = sanitizeSentryEvent(event);
    expect(sanitized.request).toEqual({
      method: 'POST',
      url: 'https://api.example.com/api/drops'
    });
    expect(sanitized.exception).toEqual(event.exception);
    expect(JSON.stringify(sanitized)).not.toContain('private');
    expect(event.request?.data).toEqual({ moderation: 'private evidence' });
  });

  it('reconstructs private moderation errors without bodies, rationale, breadcrumb, context or stack locals', () => {
    const event: LambdaSentryEvent = {
      event_id: 'abc123',
      environment: 'production',
      release: 'commit123',
      request: {
        ...sensitiveRequest,
        url: 'https://api.example.com/api/content-moderation/checks/private-check/decision'
      },
      message: 'private evidence',
      logentry: { message: 'private rationale' },
      extra: {
        request: sensitiveRequest,
        modelResponse: 'private provider response'
      },
      user: { id: 'private user' },
      tags: { payload: 'private payload' },
      breadcrumbs: [{ message: 'private breadcrumb' }],
      contexts: {
        trace: {
          trace_id: '0123456789abcdef0123456789abcdef',
          span_id: '0123456789abcdef',
          data: { prompt: 'private prompt' }
        },
        response: { body: 'private response' }
      },
      exception: {
        values: [
          {
            type: 'CustomApiCompliantException',
            value: 'private rationale',
            stacktrace: {
              frames: [
                {
                  filename: 'src/content-moderation.service.ts',
                  function: 'readCheck',
                  lineno: 12,
                  colno: 4,
                  in_app: true,
                  vars: { evidence: 'private stack local' },
                  context_line: 'private code',
                  pre_context: ['private preceding code'],
                  abs_path: 'private absolute path'
                }
              ]
            }
          }
        ]
      }
    };
    const sanitized = sanitizeSentryEvent(event);
    expect(JSON.stringify(sanitized).toLowerCase()).not.toMatch(
      /private (evidence|rationale|provider|user|payload|breadcrumb|prompt|response|stack|code|preceding|absolute)/
    );
    expect(sanitized.extra).toBeUndefined();
    expect(sanitized.user).toBeUndefined();
    expect(sanitized.breadcrumbs).toBeUndefined();
    expect(sanitized.request).toEqual({ method: 'POST' });
    expect(sanitized.contexts).toEqual({
      trace: {
        trace_id: '0123456789abcdef0123456789abcdef',
        span_id: '0123456789abcdef'
      }
    });
    expect(sanitized.exception?.values?.[0]).toEqual({
      type: 'CustomApiCompliantException',
      value: 'Private moderation operation failed',
      stacktrace: {
        frames: [
          {
            filename: 'src/content-moderation.service.ts',
            function: 'readCheck',
            module: undefined,
            lineno: 12,
            colno: 4,
            in_app: true
          }
        ]
      }
    });
  });

  it('covers encoded private route names and drops malformed request URLs safely', () => {
    expect(
      sanitizeSentryEvent({
        request: { url: '/api/%63ontent-moderation/checks/123' },
        extra: { raw: 'private' }
      }).extra
    ).toBeUndefined();
    expect(
      sanitizeSentryEvent({
        request: { url: 'https://[invalid', data: 'private' }
      }).request?.url
    ).toBeUndefined();
  });
});
