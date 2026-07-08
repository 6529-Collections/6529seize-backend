jest.mock('@/api/async.router', () => ({
  asyncRouter: () => ({
    post: jest.fn()
  })
}));

jest.mock('./ci-pipeline-alert.service', () => ({
  ciPipelineAlertService: {
    postAlert: jest.fn()
  }
}));

import {
  buildCiPipelineAlertDedupeKey,
  computeCiPipelineAlertSignature,
  verifyCiPipelineAlertSignature
} from './ci-pipeline-alert.routes';

function makeRequest({
  rawBody,
  timestamp,
  signature
}: {
  readonly rawBody: Buffer;
  readonly timestamp?: string;
  readonly signature?: string;
}) {
  const headers: Record<string, string | undefined> = {
    'x-6529-ci-timestamp': timestamp,
    'x-6529-ci-signature': signature
  };
  return {
    rawBody,
    get: jest.fn((name: string) => headers[name.toLowerCase()])
  } as any;
}

describe('ci pipeline alert routes', () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
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
});
