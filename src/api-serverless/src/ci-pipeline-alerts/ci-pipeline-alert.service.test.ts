jest.mock('@/api/drops/drop-creation.api.service', () => ({
  dropCreationService: {
    createDrop: jest.fn()
  }
}));

jest.mock('@/identities/identities.db', () => ({
  identitiesDb: {
    getIdsByHandles: jest.fn()
  }
}));

import fc from 'fast-check';
import {
  CiPipelineAlertService,
  formatMarkdownLink,
  normalizeConfiguredHandle,
  normalizeContributorGithubLogins,
  normalizeTargetEnvironment,
  parseProfileHandles,
  truncate
} from './ci-pipeline-alert.service';

const baseRequest = {
  repo: '6529seize-frontend',
  workflow: 'Web Deploy - PROD',
  status: 'failure' as const,
  title: 'Seize PROD WEB DEPLOY: CI pipeline is broken!!!',
  description: 'abc123 - Fix deploy',
  triggered_by_github_login: 'prxt6529',
  run_id: '12345',
  run_number: '6082',
  run_url:
    'https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345',
  sha: 'abc1234567890',
  branch: 'main',
  environment: 'production',
  service: 'web'
};

describe('CiPipelineAlertService', () => {
  let originalEnv: Record<string, string | undefined>;
  let dropCreationApiService: {
    createDrop: jest.Mock;
    toggleHideLinkPreview: jest.Mock;
  };
  let identitiesRepository: { getIdsByHandles: jest.Mock };
  let releaseNotesQueue: { enqueueBestEffort: jest.Mock };

  beforeEach(() => {
    originalEnv = {
      CI_PIPELINES_STAGING_WAVE_ID: process.env.CI_PIPELINES_STAGING_WAVE_ID,
      CI_PIPELINES_PROD_WAVE_ID: process.env.CI_PIPELINES_PROD_WAVE_ID,
      CI_PIPELINES_BOT_PROFILE_ID: process.env.CI_PIPELINES_BOT_PROFILE_ID,
      CI_PIPELINES_FAILURE_MENTION_PROFILE_HANDLES:
        process.env.CI_PIPELINES_FAILURE_MENTION_PROFILE_HANDLES
    };
    process.env.CI_PIPELINES_STAGING_WAVE_ID = 'staging-wave';
    process.env.CI_PIPELINES_PROD_WAVE_ID = 'prod-wave';
    process.env.CI_PIPELINES_BOT_PROFILE_ID = 'bot-profile';
    process.env.CI_PIPELINES_FAILURE_MENTION_PROFILE_HANDLES =
      '@prxt0, @alice, @[Bob], alice, missing';
    dropCreationApiService = {
      createDrop: jest.fn().mockResolvedValue({ id: 'drop-1' }),
      toggleHideLinkPreview: jest.fn().mockResolvedValue({})
    };
    identitiesRepository = {
      getIdsByHandles: jest.fn().mockResolvedValue({
        prxt0: 'profile-initiator',
        ALICE: 'profile-1',
        Bob: 'profile-2'
      })
    };
    releaseNotesQueue = {
      enqueueBestEffort: jest.fn().mockResolvedValue(undefined)
    };
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('keeps truncated arbitrary content within the target length', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer({ min: 3, max: 120 }),
        (value, maxLength) => {
          const truncated = truncate(value, maxLength);

          expect(truncated.length).toBeLessThanOrEqual(maxLength);
          if (value.length <= maxLength) {
            expect(truncated).toBe(value);
          } else {
            expect(truncated.endsWith('...')).toBe(true);
            expect(value.startsWith(truncated.slice(0, -3))).toBe(true);
            expect(truncated.slice(0, -3)).not.toMatch(/[\uD800-\uDBFF]$/);
          }
        }
      )
    );
  });

  it('escapes arbitrary markdown link labels', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (label, url) => {
        const escapedLabel = label
          .split('[')
          .join(String.raw`\[`)
          .split(']')
          .join(String.raw`\]`);

        expect(formatMarkdownLink(label, url)).toBe(
          `[${escapedLabel}](${url})`
        );
      })
    );
  });

  it('normalizes arbitrary configured profile handles', () => {
    const handleCharacters =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split(
        ''
      );
    const handleArbitrary = fc
      .array(fc.constantFrom(...handleCharacters), {
        minLength: 1,
        maxLength: 30
      })
      .map((chars) => chars.join(''));

    fc.assert(
      fc.property(handleArbitrary, (handle) => {
        expect(normalizeConfiguredHandle(` @${handle} `)).toBe(handle);
        expect(normalizeConfiguredHandle(` @[${handle}] `)).toBe(handle);
      })
    );
  });

  it('dedupes arbitrary configured profile handles case-insensitively', () => {
    const handleCharacters =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split(
        ''
      );
    const handleArbitrary = fc
      .array(fc.constantFrom(...handleCharacters), {
        minLength: 1,
        maxLength: 20
      })
      .map((chars) => chars.join(''));

    fc.assert(
      fc.property(fc.array(handleArbitrary, { maxLength: 20 }), (handles) => {
        const input = handles
          .flatMap((handle) => [` @${handle} `, ` @[${handle.toUpperCase()}] `])
          .join(',');
        const parsedHandles = parseProfileHandles(input);
        const normalizedHandles = parsedHandles.map((handle) =>
          handle.toLowerCase()
        );

        expect(new Set(normalizedHandles).size).toBe(parsedHandles.length);
        for (const parsedHandle of parsedHandles) {
          expect(parsedHandle).not.toMatch(/^@/);
        }
      })
    );
  });

  it('normalizes arbitrary target environment casing and spacing', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('staging', 'prod', 'production'),
        fc.constantFrom('', ' ', '  ', '\t', '\n'),
        fc.constantFrom('', ' ', '  ', '\t', '\n'),
        (environment, prefixWhitespace, suffixWhitespace) => {
          const paddedEnvironment = `${prefixWhitespace}${environment.toUpperCase()}${suffixWhitespace}`;
          const expected = environment === 'production' ? 'prod' : environment;

          expect(normalizeTargetEnvironment(paddedEnvironment)).toBe(expected);
        }
      )
    );
  });

  it('normalizes and deduplicates contributor GitHub logins', () => {
    expect(
      normalizeContributorGithubLogins([
        ' GelatoGenesis ',
        'gelatogenesis',
        'ragnep',
        'dependabot[bot]',
        'trailing-',
        'double--hyphen',
        'invalid login'
      ])
    ).toEqual(['GelatoGenesis', 'ragnep', 'dependabot[bot]']);
  });

  it('posts failures with configured profile mentions', async () => {
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any
    );
    const ctx = {};

    await service.postAlert(baseRequest, ctx as any);

    expect(identitiesRepository.getIdsByHandles).toHaveBeenCalledWith([
      'prxt0',
      'alice',
      'Bob',
      'missing'
    ]);
    expect(dropCreationApiService.createDrop).toHaveBeenCalledWith(
      expect.objectContaining({
        authorId: 'bot-profile',
        representativeId: 'bot-profile',
        hideLinkPreview: true,
        createDropRequest: expect.objectContaining({
          wave_id: 'prod-wave',
          title: null,
          metadata: [],
          mentioned_users: [
            {
              mentioned_profile_id: 'profile-initiator',
              handle_in_content: 'prxt0'
            },
            {
              mentioned_profile_id: 'profile-1',
              handle_in_content: 'ALICE'
            },
            {
              mentioned_profile_id: 'profile-2',
              handle_in_content: 'Bob'
            }
          ],
          parts: [
            expect.objectContaining({
              content: expect.stringContaining(
                [
                  '[PROD] Seize PROD WEB DEPLOY: CI pipeline is broken!!! 🚨',
                  '',
                  'abc123 - Fix deploy',
                  '',
                  'Service: Frontend - web',
                  'Workflow: Web Deploy - PROD',
                  'Branch: main',
                  'Commit: [abc12345](https://github.com/6529-Collections/6529seize-frontend/commit/abc1234567890)',
                  'Initiated by: @[prxt0]',
                  'Run: [#6082](https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345)',
                  '',
                  'cc @[prxt0] @[ALICE] @[Bob]'
                ].join('\n')
              )
            })
          ]
        })
      }),
      expect.objectContaining({
        authenticationContext: expect.objectContaining({
          authenticatedProfileId: 'bot-profile'
        })
      })
    );
    expect(dropCreationApiService.toggleHideLinkPreview).not.toHaveBeenCalled();
  });

  it('routes staging successes with an initiator mention', async () => {
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any
    );

    await service.postAlert(
      {
        ...baseRequest,
        status: 'success',
        title: 'Seize Lambda staging api DEPLOY CI pipeline complete',
        environment: 'staging'
      },
      {}
    );

    expect(identitiesRepository.getIdsByHandles).toHaveBeenCalledWith([
      'prxt0'
    ]);
    expect(dropCreationApiService.createDrop).toHaveBeenCalledWith(
      expect.objectContaining({
        hideLinkPreview: true,
        createDropRequest: expect.objectContaining({
          wave_id: 'staging-wave',
          title: null,
          metadata: [],
          mentioned_users: [
            {
              mentioned_profile_id: 'profile-initiator',
              handle_in_content: 'prxt0'
            }
          ],
          parts: [
            expect.objectContaining({
              content: expect.stringContaining(
                [
                  '[STAGING 🚧] Seize Lambda staging api DEPLOY CI pipeline complete ✅',
                  '',
                  'abc123 - Fix deploy',
                  '',
                  'Service: Frontend - web',
                  'Workflow: Web Deploy - PROD',
                  'Branch: main',
                  'Commit: [abc12345](https://github.com/6529-Collections/6529seize-frontend/commit/abc1234567890)',
                  'Initiated by: @[prxt0]',
                  'Run: [#6082](https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345)'
                ].join('\n')
              )
            })
          ]
        })
      }),
      expect.anything()
    );
    expect(
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest
        .parts[0].content
    ).toBe(
      [
        '[STAGING 🚧] Seize Lambda staging api DEPLOY CI pipeline complete ✅',
        '',
        'abc123 - Fix deploy',
        '',
        'Service: Frontend - web',
        'Workflow: Web Deploy - PROD',
        'Branch: main',
        'Commit: [abc12345](https://github.com/6529-Collections/6529seize-frontend/commit/abc1234567890)',
        'Initiated by: @[prxt0]',
        'Run: [#6082](https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345)'
      ].join('\n')
    );
    expect(
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest.parts[0].content.startsWith(
        '\n'
      )
    ).toBe(false);
    expect(
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest
        .parts[0].content
    ).not.toContain('cc @[');
    expect(dropCreationApiService.toggleHideLinkPreview).not.toHaveBeenCalled();
  });

  it.each([
    { environment: 'staging', waveId: 'staging-wave' },
    { environment: 'prod', waveId: 'prod-wave' }
  ] as const)(
    'attributes $environment deployments to the Release Train',
    async ({ environment, waveId }) => {
      const service = new CiPipelineAlertService(
        dropCreationApiService as any,
        identitiesRepository as any
      );

      await service.postAlert(
        {
          ...baseRequest,
          status: 'success',
          environment,
          triggered_by_github_login: '6529-release-bus[bot]'
        },
        {}
      );

      expect(identitiesRepository.getIdsByHandles).not.toHaveBeenCalled();
      expect(
        dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest
      ).toEqual(
        expect.objectContaining({
          wave_id: waveId,
          mentioned_users: [],
          parts: [
            expect.objectContaining({
              content: expect.stringContaining('Initiated by: Release Train')
            })
          ]
        })
      );
    }
  );

  it('adds mapped train contributors as real mentions and links unmapped contributors', async () => {
    identitiesRepository.getIdsByHandles.mockResolvedValue({
      GelatoGenesis: 'profile-gelato',
      ragne: 'profile-ragne'
    });
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any
    );

    await service.postAlert(
      {
        ...baseRequest,
        status: 'success',
        environment: 'staging',
        triggered_by_github_login: '6529-release-bus[bot]',
        release_train_id: 'train-123',
        contributor_github_logins: [
          'GelatoGenesis',
          'ragnep',
          'external-user',
          'gelatogenesis'
        ]
      },
      {}
    );

    expect(identitiesRepository.getIdsByHandles).toHaveBeenCalledWith([
      'GelatoGenesis',
      'ragne'
    ]);
    const createDropRequest =
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest;
    expect(createDropRequest.mentioned_users).toEqual([
      {
        mentioned_profile_id: 'profile-gelato',
        handle_in_content: 'GelatoGenesis'
      },
      {
        mentioned_profile_id: 'profile-ragne',
        handle_in_content: 'ragne'
      }
    ]);
    expect(createDropRequest.parts[0].content).toContain(
      [
        'Initiated by: Release Train',
        'Contributors: @[GelatoGenesis], @[ragne], [@external-user](https://github.com/external-user)'
      ].join('\n')
    );
  });

  it('ignores contributor metadata for a manually initiated deployment', async () => {
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any
    );

    await service.postAlert(
      {
        ...baseRequest,
        status: 'success',
        release_train_id: 'train-123',
        contributor_github_logins: ['GelatoGenesis']
      },
      {}
    );

    const content =
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest
        .parts[0].content;
    expect(content).toContain('Initiated by: @[prxt0]');
    expect(content).not.toContain('Contributors:');
  });

  it('posts with an unknown initiator when the 6529 mapping is missing', async () => {
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any
    );

    await service.postAlert(
      {
        ...baseRequest,
        status: 'success',
        triggered_by_github_login: 'unknown-user'
      },
      {}
    );

    expect(identitiesRepository.getIdsByHandles).not.toHaveBeenCalled();
    expect(
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest
        .parts[0].content
    ).toContain('Initiated by: unknown');
    expect(
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest
        .mentioned_users
    ).toEqual([]);
  });

  it('posts with an unknown initiator when the mapped profile is missing', async () => {
    identitiesRepository.getIdsByHandles.mockResolvedValue({});
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any
    );

    await service.postAlert({ ...baseRequest, status: 'success' }, {});

    expect(
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest
        .parts[0].content
    ).toContain('Initiated by: unknown');
    expect(
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest
        .mentioned_users
    ).toEqual([]);
  });

  it('posts with an unknown initiator when actor metadata is absent', async () => {
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any
    );

    await service.postAlert(
      {
        ...baseRequest,
        status: 'success',
        triggered_by_github_login: null
      },
      {}
    );

    expect(identitiesRepository.getIdsByHandles).not.toHaveBeenCalled();
    expect(
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest
        .parts[0].content
    ).toContain('Initiated by: unknown');
  });

  it('enqueues release-note generation after posting an eligible production success', async () => {
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any,
      releaseNotesQueue as any
    );

    await service.postAlert(
      {
        ...baseRequest,
        status: 'success',
        release_notes_prompt_path: 'ops/release-notes/release-notes.prompt.md',
        release_group_id: 'frontend-release',
        release_group_services: ['web'],
        deployed_at: '2026-07-13T11:38:00.000Z'
      },
      {}
    );

    expect(releaseNotesQueue.enqueueBestEffort).toHaveBeenCalledWith({
      repo: baseRequest.repo,
      workflow: baseRequest.workflow,
      run_id: baseRequest.run_id,
      run_number: baseRequest.run_number,
      run_url: baseRequest.run_url,
      sha: baseRequest.sha,
      branch: baseRequest.branch,
      environment: 'prod',
      service: baseRequest.service,
      prompt_path: 'ops/release-notes/release-notes.prompt.md',
      release_group_id: 'frontend-release',
      release_group_services: ['web'],
      pull_request_number: null,
      publish_release_note: false,
      deployed_at: '2026-07-13T11:38:00.000Z'
    });
    expect(
      dropCreationApiService.createDrop.mock.invocationCallOrder[0]
    ).toBeLessThan(
      releaseNotesQueue.enqueueBestEffort.mock.invocationCallOrder[0]
    );
  });

  it('does not enqueue an unreviewed repository prompt path', async () => {
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any,
      releaseNotesQueue as any
    );

    await service.postAlert(
      {
        ...baseRequest,
        status: 'success',
        release_notes_prompt_path: 'unreviewed.prompt.md',
        release_group_id: 'frontend-release',
        release_group_services: ['web'],
        deployed_at: '2026-07-13T11:38:00.000Z'
      },
      {}
    );

    expect(releaseNotesQueue.enqueueBestEffort).not.toHaveBeenCalled();
  });

  it('requires an explicit PR before enqueueing backend release notes', async () => {
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any,
      releaseNotesQueue as any
    );
    const backendRequest = {
      ...baseRequest,
      repo: '6529seize-backend',
      workflow: 'Deploy a service',
      service: 'api',
      status: 'success' as const,
      release_notes_prompt_path: 'ops/release-notes/release-notes.prompt.md',
      release_group_id: 'pr-1749',
      release_group_services: ['dbMigrationsLoop', 'claimsBuilder', 'api'],
      deployed_at: '2026-07-14T12:16:00.000Z'
    };

    await service.postAlert(backendRequest, {});

    expect(releaseNotesQueue.enqueueBestEffort).not.toHaveBeenCalled();

    await service.postAlert(
      {
        ...backendRequest,
        pull_request_number: 1749,
        publish_release_note: true
      },
      {}
    );

    expect(releaseNotesQueue.enqueueBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        release_group_id: 'pr-1749',
        release_group_services: ['api', 'claimsBuilder', 'dbMigrationsLoop'],
        pull_request_number: 1749,
        publish_release_note: true
      })
    );
  });

  it('fans one v2 deploy success out to every PR-scoped release-note group', async () => {
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any,
      releaseNotesQueue as any
    );

    await service.postAlert(
      {
        ...baseRequest,
        repo: '6529seize-backend',
        workflow: 'Deploy a service',
        service: 'api',
        status: 'success',
        release_notes_prompt_path: 'ops/release-notes/release-notes.prompt.md',
        release_note_groups: [
          {
            release_group_id: 'pr-1801',
            release_group_services: ['worker', 'api'],
            pull_request_number: 1801,
            publish_release_note: true
          },
          {
            release_group_id: 'pr-1802',
            release_group_services: ['api'],
            pull_request_number: 1802,
            publish_release_note: false
          }
        ],
        deployed_at: '2026-07-23T11:00:00.000Z'
      },
      {}
    );

    expect(releaseNotesQueue.enqueueBestEffort).toHaveBeenCalledTimes(2);
    expect(releaseNotesQueue.enqueueBestEffort).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        release_group_id: 'pr-1801',
        release_group_services: ['api', 'worker'],
        pull_request_number: 1801,
        publish_release_note: true
      })
    );
    expect(releaseNotesQueue.enqueueBestEffort).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        release_group_id: 'pr-1802',
        release_group_services: ['api'],
        pull_request_number: 1802,
        publish_release_note: false
      })
    );
  });

  it('formats desktop alerts with the product label and existing emoji', async () => {
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any
    );

    await service.postAlert(
      {
        ...baseRequest,
        repo: '6529-core',
        workflow: 'Publish',
        status: 'success',
        title: 'Desktop Publish completed 🚀',
        description:
          'Production v0.3.11 publish completed with S3 and Arweave links published and CloudFront invalidated.',
        branch: 'v0.3.11',
        service: 'desktop',
        run_url:
          'https://github.com/6529-Collections/6529-core/actions/runs/12345'
      },
      {}
    );

    expect(
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest
        .parts[0].content
    ).toBe(
      [
        '[PROD] Desktop Publish completed 🚀 ✅',
        '',
        'Production v0.3.11 publish completed with S3 and Arweave links published and CloudFront invalidated.',
        '',
        'Service: 6529 Desktop',
        'Workflow: Publish',
        'Branch: v0.3.11',
        'Commit: [abc12345](https://github.com/6529-Collections/6529-core/commit/abc1234567890)',
        'Initiated by: @[prxt0]',
        'Run: [#6082](https://github.com/6529-Collections/6529-core/actions/runs/12345)'
      ].join('\n')
    );
  });

  it.each([null, ''])(
    'falls back to the workflow for title %p',
    async (title) => {
      const service = new CiPipelineAlertService(
        dropCreationApiService as any,
        identitiesRepository as any
      );

      await service.postAlert({ ...baseRequest, title } as any, {});

      expect(
        dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest.parts[0].content.startsWith(
          '[PROD] Web Deploy - PROD 🚨'
        )
      ).toBe(true);
    }
  );

  it('normalizes conflicting status emojis', async () => {
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any
    );

    await service.postAlert(
      { ...baseRequest, title: 'Build succeeded ✅ ❌ 🚨', status: 'success' },
      {}
    );

    const content =
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest
        .parts[0].content;
    expect(content.startsWith('[PROD] Build succeeded ✅')).toBe(true);
    expect(content.startsWith('[PROD] Build succeeded ✅ ❌ 🚨')).toBe(false);
  });

  it('preserves the outcome and run metadata when text is long', async () => {
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any
    );

    await service.postAlert(
      {
        ...baseRequest,
        title: `${'a'.repeat(234)}🚀${'a'.repeat(20)}`,
        description: `[details](${'https://example.com/'}${'b'.repeat(30000)})`
      },
      {}
    );

    const content =
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest
        .parts[0].content;
    const heading = content.split('\n')[0];
    expect(heading.endsWith('🚨')).toBe(true);
    expect(heading.length).toBeLessThanOrEqual(250);
    expect(Buffer.from(heading, 'utf8').toString('utf8')).toBe(heading);
    expect(content).toContain(
      'Run: [#6082](https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345)'
    );
    expect(content).toContain('\\[details\\](');
  });

  it('only applies the desktop product label to the exact service', async () => {
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any
    );

    await service.postAlert(
      {
        ...baseRequest,
        repo: '6529-core',
        service: 'desktop-canary'
      },
      {}
    );

    expect(
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest
        .parts[0].content
    ).toContain('Service: Core - desktop-canary');
  });
});
