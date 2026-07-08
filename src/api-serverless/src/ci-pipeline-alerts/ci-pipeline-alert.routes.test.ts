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

describe('ci pipeline alert routes', () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    originalSecret = process.env.CI_PIPELINES_WEBHOOK_SECRET;
    process.env.CI_PIPELINES_WEBHOOK_SECRET = 'test-secret';
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.CI_PIPELINES_WEBHOOK_SECRET;
    } else {
      process.env.CI_PIPELINES_WEBHOOK_SECRET = originalSecret;
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

  it('posts alerts without Redis dedupe when Redis is unavailable', async () => {
    (getRedisClient as jest.Mock).mockReturnValue(null);
    (ciPipelineAlertService.postAlert as jest.Mock).mockResolvedValue(undefined);
    const res = makeResponse();

    await ciPipelineAlertHandler(makeAlertRequest(), res);

    expect(ciPipelineAlertService.postAlert).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith({});
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
