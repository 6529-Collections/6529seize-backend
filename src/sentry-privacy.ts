import type * as Sentry from '@sentry/serverless';

type Event = Parameters<typeof Sentry.captureEvent>[0];
type Exception = NonNullable<NonNullable<Event['exception']>['values']>[number];
type StackFrame = NonNullable<
  NonNullable<Exception['stacktrace']>['frames']
>[number];
const PRIVATE_ROUTE = /(?:^|\/)content-moderation(?:\/|$)/i;

function requestUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, 'https://request.invalid');
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return undefined;
  }
}

function privateRoute(url: URL | undefined): boolean {
  if (!url) return false;
  try {
    return PRIVATE_ROUTE.test(decodeURIComponent(url.pathname));
  } catch {
    return PRIVATE_ROUTE.test(url.pathname);
  }
}

function safeToken(value: string | undefined, limit = 128): string | undefined {
  return value && value.length <= limit && /^[\w./:@-]+$/.test(value)
    ? value
    : undefined;
}

function safeFrame(frame: StackFrame): StackFrame {
  return {
    filename: safeToken(frame.filename, 512),
    function: safeToken(frame.function),
    module: safeToken(frame.module),
    lineno: frame.lineno,
    colno: frame.colno,
    in_app: frame.in_app
  };
}

function safeException(exception: Exception): Exception {
  return {
    type: safeToken(exception.type) ?? 'Error',
    value: 'Private moderation operation failed',
    stacktrace: {
      frames: exception.stacktrace?.frames?.slice(-50).map(safeFrame)
    }
  };
}

function safeTrace(event: Event): Event['contexts'] {
  const traceId = event.contexts?.trace?.trace_id;
  const spanId = event.contexts?.trace?.span_id;
  if (
    !traceId ||
    !spanId ||
    !/^[a-f\d]{32}$/i.test(traceId) ||
    !/^[a-f\d]{16}$/i.test(spanId)
  )
    return undefined;
  return { trace: { trace_id: traceId, span_id: spanId } };
}

/** Private routes retain only bounded operational metadata, never evidence or request content. */
function privateEvent(event: Event): Event {
  return {
    event_id: safeToken(event.event_id),
    timestamp: event.timestamp,
    platform: 'node',
    level: event.level,
    environment: safeToken(event.environment),
    release: safeToken(event.release),
    dist: safeToken(event.dist),
    transaction: '/content-moderation/[private]',
    request: { method: safeToken(event.request?.method, 12) },
    exception: {
      values: event.exception?.values?.slice(0, 5).map(safeException)
    },
    contexts: safeTrace(event)
  };
}

export function sanitizeSentryEvent(
  event: Event,
  originalRequestUrl?: string
): Event {
  const url = requestUrl(event.request?.url);
  if (privateRoute(url) || privateRoute(requestUrl(originalRequestUrl)))
    return privateEvent(event);
  if (!event.request && !event.user) return event;
  // Form bodies can contain moderation evidence on otherwise ordinary drop/profile/REP routes.
  // Reconstruct the request to exclude data, cookies, headers, query strings and SDK request env.
  return {
    ...event,
    user: undefined,
    request: event.request
      ? {
          method: safeToken(event.request.method, 12),
          url: url?.toString()
        }
      : undefined
  };
}
