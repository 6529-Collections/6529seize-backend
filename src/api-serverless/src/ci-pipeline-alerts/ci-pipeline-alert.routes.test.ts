const mockRouterPost = jest.fn();

jest.mock('@/api/async.router', () => ({
  asyncRouter: () => ({
    post: mockRouterPost
  })
}));

jest.mock('@/redis', () => ({
  getRedisClient: jest.fn()
}));

jest.mock('./ci-pipeline-alert.service', () => ({
  ciPipelineAlertService: {
    postAlert: jest.fn()
  }
}));

import fc from 'fast-check';
import { getRedisClient } from '@/redis';
import {
  buildCiPipelineAlertDedupeKey,
  computeCiPipelineAlertSignature,
  verifyCiPipelineAlertSignature
} from './ci-pipeline-alert.routes';
import { ciPipelineAlertService } from './ci-pipeline-alert.service';

const ciPipelineAlertHandler = mockRouterPost.mock.calls[0][1];

function makeRequest({
  rawBody,
  timestamp,
  signature,
  body
}: {
  readonly rawBody: Buffer;
  readonly timestamp?: string;
  readonly signature?: string;
  readonly body?: Record<string, unknown>;
}) {
  const headers: Record<string, string | undefined> = {
    'x-6529-ci-timestamp': timestamp,
    'x-6529-ci-signature': signature
  };
  return {
    rawBody,
    body,
    get: jest.fn((name: string) => headers[name.toLowerCase()])
  } as any;
}

function makeAlertRequest(body: Record<string, unknown> = {}) {
  const requestBody = {
    repo: '6529seize-backend',
    workflow: 'Deploy a service',
    status: 'failure',
    title: 'Backend deploy failed',
    run_id: '123',
    run_url:
      'https://github.com/6529-Collections/6529seize-backend/actions/runs/123',
    environment: 'production',
    ...body
  };
  const rawBody = Buffer.from(JSON.stringify(requestBody));
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = computeCiPipelineAlertSignature({
    secret: 'test-secret',
    timestamp,
    rawBody
  });
  return makeRequest({
    rawBody,
    timestamp,
    signature: `sha256=${signature}`,
    body: requestBody
  });
}

function makeResponse() {
  const res = {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis()
  };
  return res as any;
}

const alertTextCharacters =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split('');
const alertTextArbitrary = fc
  .array(fc.constantFrom(...alertTextCharacters), {
    minLength: 1,
    maxLength: 40
  })
  .map((chars) => chars.join(''));

const optionalAlertTextArbitrary = fc.option(alertTextArbitrary, { nil: null });

const ciPipelineAlertChangedFields = [
  'repo',
  'workflow',
  'run_id',
  'run_url',
  'status',
  'title',
  'description',
  'sha',
  'branch',
  'environment',
  'service'
] as const;

const ciPipelineAlertRequestArbitrary = fc
  .record({
    repo: alertTextArbitrary,
    workflow: alertTextArbitrary,
    status: fc.constantFrom('success' as const, 'failure' as const),
    title: alertTextArbitrary,
    run_id: alertTextArbitrary,
    run_number: optionalAlertTextArbitrary,
    run_url: alertTextArbitrary.map(
      (runId) =>
        `https://github.com/6529-Collections/repo/actions/runs/${runId}`
    ),
    description: optionalAlertTextArbitrary,
    sha: optionalAlertTextArbitrary,
    branch: optionalAlertTextArbitrary,
    environment: fc.constantFrom('staging', 'prod', 'production'),
    service: optionalAlertTextArbitrary
  })
  .map((request) => ({
    ...request,
    repo: `6529-${request.repo}`,
    workflow: `workflow-${request.workflow}`,
    title: `title-${request.title}`,
    run_id: `run-${request.run_id}`
  }));

describe('ci pipeline alert routes', () => {
  let originalAlertSecret: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    originalAlertSecret = process.env.CI_PIPELINES_ALERT_SECRET;
    process.env.CI_PIPELINES_ALERT_SECRET = 'test-secret';
  });

  afterEach(() => {
    if (originalAlertSecret === undefined) {
      delete process.env.CI_PIPELINES_ALERT_SECRET;
    } else {
      process.env.CI_PIPELINES_ALERT_SECRET = originalAlertSecret;
    }
  });

  it('verifies signed alert payloads', () => {
    const rawBody = Buffer.from(
      JSON.stringify({ repo: '6529seize-frontend', run_id: '1' })
    );
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = computeCiPipelineAlertSignature({
      secret: 'test-secret',
      timestamp,
      rawBody
    });

    expect(
      verifyCiPipelineAlertSignature(
        makeRequest({
          rawBody,
          timestamp,
          signature: `sha256=${signature}`
        })
      )
    ).toEqual({ ok: true });
  });

  it('verifies arbitrary signed alert payloads within timestamp skew', () => {
    fc.assert(
      fc.property(
        ciPipelineAlertRequestArbitrary,
        fc.integer({ min: -250, max: 250 }),
        (payload, timestampOffsetSeconds) => {
          const rawBody = Buffer.from(JSON.stringify(payload));
          const timestamp = (
            Math.floor(Date.now() / 1000) + timestampOffsetSeconds
          ).toString();
          const signature = computeCiPipelineAlertSignature({
            secret: 'test-secret',
            timestamp,
            rawBody
          });

          expect(
            verifyCiPipelineAlertSignature(
              makeRequest({
                rawBody,
                timestamp,
                signature: `sha256=${signature}`
              })
            )
          ).toEqual({ ok: true });
        }
      )
    );
  });

  it('rejects expired signatures', () => {
    const rawBody = Buffer.from('{}');
    const timestamp = (Math.floor(Date.now() / 1000) - 1000).toString();
    const signature = computeCiPipelineAlertSignature({
      secret: 'test-secret',
      timestamp,
      rawBody
    });

    expect(
      verifyCiPipelineAlertSignature(
        makeRequest({
          rawBody,
          timestamp,
          signature
        })
      )
    ).toMatchObject({
      ok: false,
      statusCode: 401
    });
  });

  it('builds distinct dedupe keys for different notification titles', () => {
    const common = {
      repo: '6529-core',
      workflow: 'Build 6529 Desktop',
      status: 'success' as const,
      run_id: '99',
      run_url: 'https://github.com/6529-Collections/6529-core/actions/runs/99'
    };

    expect(
      buildCiPipelineAlertDedupeKey({
        ...common,
        title: '6529 Desktop - S3 links published',
        environment: 'Production'
      })
    ).not.toEqual(
      buildCiPipelineAlertDedupeKey({
        ...common,
        title: '6529 Desktop - Build complete',
        environment: 'Production'
      })
    );
  });

  it('builds distinct dedupe keys for different alert payload details', () => {
    const common = {
      repo: '6529-core',
      workflow: 'Build 6529 Desktop',
      status: 'failure' as const,
      run_id: '99',
      title: '6529 Desktop - Build failed',
      environment: 'Production',
      service: 'desktop'
    };

    expect(
      buildCiPipelineAlertDedupeKey({
        ...common,
        run_url:
          'https://github.com/6529-Collections/6529-core/actions/runs/99',
        description: 'first failure'
      })
    ).not.toEqual(
      buildCiPipelineAlertDedupeKey({
        ...common,
        run_url:
          'https://github.com/6529-Collections/6529-core/actions/runs/99/attempts/2',
        description: 'retry failure'
      })
    );
  });

  it('builds distinct dedupe keys for arbitrary changed alert fields', () => {
    const changedFieldArbitrary = fc.constantFrom(
      ...ciPipelineAlertChangedFields
    );

    fc.assert(
      fc.property(
        ciPipelineAlertRequestArbitrary,
        changedFieldArbitrary,
        alertTextArbitrary,
        (request, changedField, nextValue) => {
          const currentValue = request[changedField] ?? '';
          const changedValue =
            changedField === 'status'
              ? request.status === 'success'
                ? 'failure'
                : 'success'
              : `${currentValue}${nextValue}`;
          const changedRequest = {
            ...request,
            [changedField]: changedValue
          };

          expect(buildCiPipelineAlertDedupeKey(changedRequest)).not.toBe(
            buildCiPipelineAlertDedupeKey(request)
          );
        }
      )
    );
  });

  it('posts alerts without Redis dedupe when Redis is unavailable', async () => {
    (getRedisClient as jest.Mock).mockReturnValue(null);
    (ciPipelineAlertService.postAlert as jest.Mock).mockResolvedValue(
      undefined
    );
    const res = makeResponse();

    await ciPipelineAlertHandler(makeAlertRequest(), res);

    expect(ciPipelineAlertService.postAlert).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith({});
  });

  it('rejects signed alert payloads with missing environments', async () => {
    (getRedisClient as jest.Mock).mockReturnValue(null);
    const res = makeResponse();

    await expect(
      ciPipelineAlertHandler(makeAlertRequest({ environment: undefined }), res)
    ).rejects.toThrow('"environment" is required');

    expect(ciPipelineAlertService.postAlert).not.toHaveBeenCalled();
  });

  it('rejects signed alert payloads with unsupported environments', async () => {
    (getRedisClient as jest.Mock).mockReturnValue(null);
    const res = makeResponse();

    await expect(
      ciPipelineAlertHandler(makeAlertRequest({ environment: 'sandbox' }), res)
    ).rejects.toThrow('"environment" must be one of');

    expect(ciPipelineAlertService.postAlert).not.toHaveBeenCalled();
  });

  it('rejects release deployment dates without a full timestamp', async () => {
    (getRedisClient as jest.Mock).mockReturnValue(null);
    const res = makeResponse();

    await expect(
      ciPipelineAlertHandler(
        makeAlertRequest({
          release_notes_prompt_path:
            'ops/release-notes/release-notes.prompt.md',
          release_group_id: 'release-group',
          release_group_services: ['api'],
          deployed_at: '2026-07-13'
        }),
        res
      )
    ).rejects.toThrow('fails to match the required pattern');

    expect(ciPipelineAlertService.postAlert).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean release-note publish flag', async () => {
    (getRedisClient as jest.Mock).mockReturnValue(null);
    const res = makeResponse();

    await expect(
      ciPipelineAlertHandler(
        makeAlertRequest({ publish_release_note: 'true' }),
        res
      )
    ).rejects.toThrow('"publish_release_note" must be a boolean');

    expect(ciPipelineAlertService.postAlert).not.toHaveBeenCalled();
  });

  it('acknowledges in-flight duplicate alerts without returning an error', async () => {
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(null),
      del: jest.fn()
    };
    (getRedisClient as jest.Mock).mockReturnValue(redis);
    const res = makeResponse();

    await ciPipelineAlertHandler(makeAlertRequest(), res);

    expect(ciPipelineAlertService.postAlert).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith({});
  });

  it('logs post failures and still acknowledges the webhook', async () => {
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValueOnce('OK'),
      del: jest.fn().mockResolvedValue(1)
    };
    (getRedisClient as jest.Mock).mockReturnValue(redis);
    (ciPipelineAlertService.postAlert as jest.Mock).mockRejectedValue(
      new Error('wave unavailable')
    );
    const res = makeResponse();

    await ciPipelineAlertHandler(makeAlertRequest(), res);

    expect(ciPipelineAlertService.postAlert).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith({});
  });
});
