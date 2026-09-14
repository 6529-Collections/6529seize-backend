import type * as Sentry from '@sentry/serverless';

type Event = Parameters<typeof Sentry.captureEvent>[0];
type Exception = NonNullable<NonNullable<Event['exception']>['values']>[number];
type StackFrame = NonNullable<
  NonNullable<Exception['stacktrace']>['frames']
>[number];

/** RPC credentials live in Alchemy URL paths, not just query strings. */
function redactProviderUrl(value: string | undefined): string | undefined {
  return value?.replace(
    /(https?:\/\/[a-z0-9.-]+\.g\.alchemy\.com\/v2\/)[^\s"'<>\\]+/gi,
    '$1[redacted]'
  );
}

function redactUrlFields<
  T extends {
    data?: Record<string, unknown>;
    message?: string;
    description?: string;
  }
>(value: T): T {
  const message = redactProviderUrl(value.message);
  const description = redactProviderUrl(value.description);
  let changed = message !== value.message || description !== value.description;
  const data = value.data
    ? Object.fromEntries(
        Object.entries(value.data).map(([key, field]) => {
          const safe =
            typeof field === 'string' ? redactProviderUrl(field) : field;
          changed ||= safe !== field;
          return [key, safe];
        })
      )
    : undefined;
  return changed
    ? {
        ...value,
        ...(value.message !== undefined ? { message } : {}),
        ...(value.description !== undefined ? { description } : {}),
        ...(data ? { data } : {})
      }
    : value;
}

export function sanitizeProviderBreadcrumb<
  T extends { data?: Record<string, unknown>; message?: string }
>(breadcrumb: T): T {
  return redactUrlFields(breadcrumb);
}

export function sanitizeProviderTransaction<
  T extends {
    spans?: Array<{ data?: Record<string, unknown>; description?: string }>;
  }
>(event: T): T {
  const spans = event.spans?.map((span) => redactUrlFields(span));
  return spans?.some((span, index) => span !== event.spans?.[index])
    ? { ...event, spans }
    : event;
}

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
  const breadcrumbs = event.breadcrumbs?.map(sanitizeProviderBreadcrumb);
  if (breadcrumbs?.some((item, index) => item !== event.breadcrumbs?.[index]))
    event = { ...event, breadcrumbs };
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
