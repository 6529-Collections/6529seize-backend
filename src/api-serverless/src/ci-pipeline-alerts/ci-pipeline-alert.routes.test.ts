const mockRouterPost = jest.fn();

jest.mock('@/api/async.router', () => ({
  asyncRouter: () => ({
    post: mockRouterPost
  })
}));

jest.mock('@/redis', () => ({
  getRedisClient: jest.fn()
}));

jest.mock('./ci-pipeline-alert.service', () => {
  const actual = jest.requireActual('./ci-pipeline-alert.service');
  return {
    ...actual,
    ciPipelineAlertService: {
      postAlert: jest.fn()
    }
  };
});

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
    triggered_by_github_login: 'prxt6529',
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
  'triggered_by_github_login',
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
    triggered_by_github_login: alertTextArbitrary,
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

  it('does not let ignored legacy contributors bypass notification dedupe', () => {
    const common = {
      repo: '6529seize-frontend',
      workflow: 'Release Bus - Deploy Frontend Production',
      status: 'success' as const,
      run_id: '99',
      run_url:
        'https://github.com/6529-Collections/6529seize-frontend/actions/runs/99',
      title: 'Deploy complete',
      triggered_by_github_login: '6529-release-bus[bot]',
      environment: 'prod'
    };

    expect(
      buildCiPipelineAlertDedupeKey({
        ...common,
        contributor_github_logins: ['first-user']
      })
    ).toBe(
      buildCiPipelineAlertDedupeKey({
        ...common,
        contributor_github_logins: ['second-user']
      })
    );
  });

  it('builds distinct dedupe keys for rerun attempts', () => {
    const common = {
      repo: '6529seize-frontend',
      workflow: 'Staging E2E',
      status: 'failure' as const,
      title: 'Staging E2E failed',
      run_id: '123',
      run_url: 'https://github.com/example/repo/actions/runs/123',
      triggered_by_github_login: 'github-actions[bot]',
      alert_type: 'web_e2e' as const,
      environment: 'staging',
      service: 'web'
    };

    expect(
      buildCiPipelineAlertDedupeKey({ ...common, run_attempt: 1 })
    ).not.toEqual(buildCiPipelineAlertDedupeKey({ ...common, run_attempt: 2 }));
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
    (ciPipelineAlertService.postAlert as jest.Mock).mockResolvedValue({
      ci_drop: 'accepted',
      release_note: 'ineligible'
    });
    const res = makeResponse();

    await ciPipelineAlertHandler(makeAlertRequest(), res);

    expect(ciPipelineAlertService.postAlert).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith({
      ci_drop: 'accepted',
      release_note: 'ineligible'
    });
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

  it('accepts legacy contributor metadata during rollout for safe omission', async () => {
    (getRedisClient as jest.Mock).mockReturnValue(null);
    (ciPipelineAlertService.postAlert as jest.Mock).mockResolvedValue({
      ci_drop: 'accepted',
      release_note: 'ineligible'
    });

    await ciPipelineAlertHandler(
      makeAlertRequest({
        contributor_github_logins: ['GelatoGenesis']
      }),
      makeResponse()
    );

    expect(ciPipelineAlertService.postAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        contributor_github_logins: ['GelatoGenesis']
      }),
      expect.any(Object)
    );
  });

  it('accepts signed release train contributor metadata', async () => {
    (getRedisClient as jest.Mock).mockReturnValue(null);
    (ciPipelineAlertService.postAlert as jest.Mock).mockResolvedValue({
      ci_drop: 'accepted',
      release_note: 'ineligible'
    });

    await ciPipelineAlertHandler(
      makeAlertRequest({
        release_train_id: 'a7d3433d-e145-4578-bc78-e96fbd34f591',
        release_operation_key:
          'rb2:a7d3433d-e145-4578-bc78-e96fbd34f591:deploy:prod:frontend:a1',
        contributor_evidence: 'release-bus-operation',
        contributor_github_logins: ['GelatoGenesis', 'prxt6529']
      }),
      makeResponse()
    );

    expect(ciPipelineAlertService.postAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        release_train_id: 'a7d3433d-e145-4578-bc78-e96fbd34f591',
        release_operation_key:
          'rb2:a7d3433d-e145-4578-bc78-e96fbd34f591:deploy:prod:frontend:a1',
        contributor_evidence: 'release-bus-operation',
        contributor_github_logins: ['GelatoGenesis', 'prxt6529']
      }),
      expect.any(Object)
    );
  });

  const structuredGroup = {
    release_group_id: 'pr-1801',
    release_group_services: ['api'],
    pull_request_number: 1801,
    publish_release_note: true
  };

  it('requires a service for structured release-note groups', async () => {
    (getRedisClient as jest.Mock).mockReturnValue(null);

    await expect(
      ciPipelineAlertHandler(
        makeAlertRequest({
          service: undefined,
          release_note_groups: [structuredGroup]
        }),
        makeResponse()
      )
    ).rejects.toThrow('service is required with release_note_groups');
  });

  it('rejects an unknown structured release-note service', async () => {
    (getRedisClient as jest.Mock).mockReturnValue(null);

    await expect(
      ciPipelineAlertHandler(
        makeAlertRequest({
          service: 'notADeployService',
          release_note_groups: [
            {
              ...structuredGroup,
              release_group_services: ['notADeployService']
            }
          ]
        }),
        makeResponse()
      )
    ).rejects.toThrow('service must be an allowlisted backend deploy service');
  });

  it('requires every structured group to contain the deployed service', async () => {
    (getRedisClient as jest.Mock).mockReturnValue(null);

    await expect(
      ciPipelineAlertHandler(
        makeAlertRequest({
          service: 'api',
          release_note_groups: [
            {
              ...structuredGroup,
              release_group_services: ['releaseBus']
            }
          ]
        }),
        makeResponse()
      )
    ).rejects.toThrow(
      'every release_note_groups entry must contain the deployed service'
    );
  });

  it('rejects unknown services inside a structured release-note group', async () => {
    (getRedisClient as jest.Mock).mockReturnValue(null);

    await expect(
      ciPipelineAlertHandler(
        makeAlertRequest({
          service: 'api',
          release_note_groups: [
            {
              ...structuredGroup,
              release_group_services: ['api', 'notADeployService']
            }
          ]
        }),
        makeResponse()
      )
    ).rejects.toThrow(
      'release_group_services must contain only allowlisted backend deploy services'
    );
  });

  it('rejects duplicate structured release-note group ids', async () => {
    (getRedisClient as jest.Mock).mockReturnValue(null);

    await expect(
      ciPipelineAlertHandler(
        makeAlertRequest({
          service: 'api',
          release_note_groups: [
            structuredGroup,
            {
              ...structuredGroup,
              pull_request_number: 1802
            }
          ]
        }),
        makeResponse()
      )
    ).rejects.toThrow('contains a duplicate value');
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
    expect(res.send).toHaveBeenCalledWith({
      ci_drop: 'duplicate',
      release_note: 'duplicate'
    });
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
    expect(res.send).toHaveBeenCalledWith({
      ci_drop: 'failed',
      release_note: 'not-requested'
    });
  });
});
