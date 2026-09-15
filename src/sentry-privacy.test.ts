import {
  sanitizeSentryEvent,
  sanitizeProviderBreadcrumb,
  sanitizeProviderTransaction
} from './sentry-privacy';
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
        request: { url: '/API/CONTENT-MODERATION/checks/123' },
        extra: { raw: 'private' }
      }).extra
    ).toBeUndefined();
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

describe('provider URL credentials', () => {
  const url =
    'https://eth-mainnet.g.alchemy.com/v2/private-test-key?secret=value';
  it.each([200, 403, undefined])(
    'redacts native fetch success/error breadcrumb URLs (%s)',
    (status) => {
      const breadcrumb = {
        category: 'http',
        data: { url, method: 'POST', status_code: status }
      };
      const safe = sanitizeProviderBreadcrumb(breadcrumb);
      expect(safe.data.url).toBe(
        'https://eth-mainnet.g.alchemy.com/v2/[redacted]'
      );
      expect(safe.data.method).toBe('POST');
      expect(safe.data.status_code).toBe(status);
      expect(breadcrumb.data.url).toBe(url);
      const event = sanitizeSentryEvent({ breadcrumbs: [breadcrumb] });
      expect(JSON.stringify(event)).not.toContain('private-test-key');
    }
  );
  it('redacts trace descriptions and URL attributes without dropping timing/status', () => {
    const event = {
      spans: [
        {
          description: `POST ${url}`,
          data: { 'http.url': url, 'http.status_code': 200 },
          timestamp: 99
        }
      ]
    };
    const safe = sanitizeProviderTransaction(event);
    expect(JSON.stringify(safe)).not.toContain('private-test-key');
    expect(JSON.stringify(safe)).not.toContain('secret=value');
    expect(safe.spans[0].timestamp).toBe(99);
    expect(safe.spans[0].data['http.status_code']).toBe(200);
  });
  it('preserves unrelated telemetry references', () => {
    const breadcrumb = {
      data: { url: 'https://api.6529.io/health', status_code: 200 }
    };
    expect(sanitizeProviderBreadcrumb(breadcrumb)).toBe(breadcrumb);
    const event = { spans: [{ description: 'GET /health' }] };
    expect(sanitizeProviderTransaction(event)).toBe(event);
  });
});
