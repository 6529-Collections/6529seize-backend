import {
  formatSentryAlertForDrop,
  processSentryAlertWebhook,
  SentryWebhookRedis
} from './sentry-alert-webhook';

function fakeRedis(): SentryWebhookRedis & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(
      async (key: string, value: string, options: { NX?: boolean }) => {
        if (options.NX && store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      }
    ),
    del: jest.fn(async (key: string) => store.delete(key))
  };
}

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function payload(eventId: string | null, title = 'TypeError: boom') {
  return {
    action: 'triggered',
    data: {
      event: {
        event_id: eventId,
        title,
        level: 'error',
        project_slug: 'api',
        web_url: 'https://sentry.io/issues/1/'
      }
    }
  };
}

async function deliver(
  body: unknown,
  redis: SentryWebhookRedis | null,
  postDrop = jest.fn(async () => undefined),
  rawBody = Buffer.from(JSON.stringify(body))
) {
  const result = await processSentryAlertWebhook({
    body,
    rawBody,
    redis,
    postDrop,
    logger
  });
  return { result, postDrop };
}

describe('processSentryAlertWebhook', () => {
  it('posts a new alert once and skips a redelivery of the same event', async () => {
    const redis = fakeRedis();
    const body = payload('a'.repeat(32));
    const first = await deliver(body, redis);
    expect(first.result.status).toBe(200);
    expect(first.postDrop).toHaveBeenCalledTimes(1);

    const second = await deliver(body, redis);
    expect(second.result.status).toBe(200);
    expect(second.postDrop).not.toHaveBeenCalled();
  });

  it('dedupes an identical body that carries no event id', async () => {
    const redis = fakeRedis();
    const body = payload(null);
    expect((await deliver(body, redis)).postDrop).toHaveBeenCalledTimes(1);
    expect((await deliver(body, redis)).postDrop).not.toHaveBeenCalled();
  });

  it('dedupes by body hash even when the event id differs from a stored one', async () => {
    const redis = fakeRedis();
    const rawBody = Buffer.from('same raw body');
    await deliver(payload('first'), redis, undefined, rawBody);
    const second = await deliver(payload('second'), redis, undefined, rawBody);
    expect(second.postDrop).not.toHaveBeenCalled();
  });

  it('does not post without Redis', async () => {
    const { result, postDrop } = await deliver(payload('event'), null);
    expect(result.status).toBe(503);
    expect(postDrop).not.toHaveBeenCalled();
  });

  it('does not post when the dedupe lookup fails', async () => {
    const redis = fakeRedis();
    jest.mocked(redis.get).mockRejectedValueOnce(new Error('down'));
    const { result, postDrop } = await deliver(payload('event'), redis);
    expect(result.status).toBe(503);
    expect(postDrop).not.toHaveBeenCalled();
  });

  it('skips while another delivery holds the processing lock', async () => {
    const redis = fakeRedis();
    redis.store.set('sentry-webhook:event:processing', '1');
    const { postDrop } = await deliver(payload('event'), redis);
    expect(postDrop).not.toHaveBeenCalled();
  });

  it('answers 500 and allows a retry when posting fails', async () => {
    const redis = fakeRedis();
    const body = payload('event');
    const failing = jest.fn(async () => {
      throw new Error('db');
    });
    expect((await deliver(body, redis, failing)).result.status).toBe(500);
    expect((await deliver(body, redis)).postDrop).toHaveBeenCalledTimes(1);
  });

  it('ignores non-triggered actions', async () => {
    const { result, postDrop } = await deliver(
      { action: 'resolved' },
      fakeRedis()
    );
    expect(result.status).toBe(200);
    expect(postDrop).not.toHaveBeenCalled();
  });
});

describe('formatSentryAlertForDrop', () => {
  it('escapes mention and link markup in provider strings', () => {
    const drop = formatSentryAlertForDrop(
      payload('event', 'Hello @[punk6529] see [x](https://evil.example) <b>')
    );
    expect(drop.content).not.toContain('@[punk6529]');
    expect(drop.content).toContain(String.raw`@\[punk6529\]`);
    expect(drop.content).toContain(String.raw`\<b\>`);
    expect(drop.title).not.toContain('@[punk6529]');
  });

  it('keeps the exception preview inside its code fence', () => {
    const body = payload('event');
    (body.data.event as any).entries = [
      {
        type: 'exception',
        data: {
          values: [
            {
              type: 'Error',
              value: 'bad ``` escape\n@[someone]',
              stacktrace: { frames: [{ function: 'run', filename: 'a.ts' }] }
            }
          ]
        }
      }
    ];
    const drop = formatSentryAlertForDrop(body);
    const fence = drop.content.split('```');
    expect(fence).toHaveLength(3);
    expect(fence[1]).not.toContain('@[someone]');
  });

  it('drops non-https URLs', () => {
    const body = payload('event');
    body.data.event.web_url = 'javascript:alert(1)';
    expect(formatSentryAlertForDrop(body).webUrl).toBeNull();
  });

  it('collapses multi-line titles to one line', () => {
    const drop = formatSentryAlertForDrop(payload('event', 'line1\nline2'));
    expect(drop.title).toBe('Sentry ERROR | api: line1 line2');
  });
});
