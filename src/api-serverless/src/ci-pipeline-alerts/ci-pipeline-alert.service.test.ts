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
import { normalizeDropGroupMentions } from '@/drops/create-or-update-drop.use-case';
import { DropGroupMention } from '@/entities/IWaveGroupNotificationSubscription';
import {
  CiPipelineAlertService,
  formatMarkdownLink,
  normalizeContributorGithubLogins,
  normalizeTargetEnvironment,
  truncate
} from './ci-pipeline-alert.service';

const baseRequest = {
  repo: '6529seize-frontend',
  workflow: 'Web Deploy - PROD',
  status: 'failure' as const,
  title: 'WEB deploy failed',
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
  let alertTargetStore: {
    rememberDeployTarget: jest.Mock;
    resolveDeployTarget: jest.Mock;
  };

  beforeEach(() => {
    originalEnv = {
      CI_PIPELINES_STAGING_WAVE_ID: process.env.CI_PIPELINES_STAGING_WAVE_ID,
      CI_PIPELINES_PROD_WAVE_ID: process.env.CI_PIPELINES_PROD_WAVE_ID,
      CI_PIPELINES_BOT_PROFILE_ID: process.env.CI_PIPELINES_BOT_PROFILE_ID
    };
    process.env.CI_PIPELINES_STAGING_WAVE_ID = 'staging-wave';
    process.env.CI_PIPELINES_PROD_WAVE_ID = 'prod-wave';
    process.env.CI_PIPELINES_BOT_PROFILE_ID = 'bot-profile';
    dropCreationApiService = {
      createDrop: jest.fn().mockResolvedValue({ id: 'drop-1' }),
      toggleHideLinkPreview: jest.fn().mockResolvedValue({})
    };
    identitiesRepository = {
      getIdsByHandles: jest.fn().mockResolvedValue({
        prxt0: 'profile-initiator'
      })
    };
    releaseNotesQueue = {
      enqueueBestEffort: jest.fn().mockResolvedValue(undefined)
    };
    alertTargetStore = {
      rememberDeployTarget: jest.fn().mockResolvedValue(undefined),
      resolveDeployTarget: jest.fn().mockResolvedValue(null)
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

  it('posts failures with the global developer mention and preserves initiator attribution', async () => {
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any
    );
    const ctx = {};

    await service.postAlert(baseRequest, ctx as any);

    expect(identitiesRepository.getIdsByHandles).toHaveBeenCalledWith([
      'prxt0'
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
            }
          ],
          parts: [
            expect.objectContaining({
              content: expect.stringContaining(
                [
                  '[🚀 PRODUCTION] WEB deploy failed 🚨',
                  '',
                  'abc123 - Fix deploy',
                  '',
                  'Service: web',
                  'Workflow: Web Deploy - PROD',
                  'Branch: main',
                  'Commit: [abc12345](https://github.com/6529-Collections/6529seize-frontend/commit/abc1234567890)',
                  'Initiated by: @[prxt0]',
                  'Run: [#6082](https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345)',
                  '',
                  'cc @devs6529'
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
    const createDropRequest =
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest;
    expect(
      normalizeDropGroupMentions({ parts: createDropRequest.parts })
    ).toEqual([DropGroupMention.DEVS_6529]);
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
        title: 'WEB deploy complete',
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
                  '[🚧 STAGING] WEB deploy complete ✅',
                  '',
                  'abc123 - Fix deploy',
                  '',
                  'Service: web',
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
        '[🚧 STAGING] WEB deploy complete ✅',
        '',
        'abc123 - Fix deploy',
        '',
        'Service: web',
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

  it.each(['api', 'overRatesRevocationLoop'])(
    'preserves the exact backend service identifier %s',
    async (serviceName) => {
      const service = new CiPipelineAlertService(
        dropCreationApiService as any,
        identitiesRepository as any,
        releaseNotesQueue as any,
        alertTargetStore as any
      );

      await service.postAlert(
        {
          ...baseRequest,
          repo: '6529seize-backend',
          workflow: 'Deploy a service',
          title: `${serviceName} deploy complete`,
          status: 'success',
          service: serviceName
        },
        {}
      );

      const content =
        dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest
          .parts[0].content;
      expect(content).toContain(
        `[🚀 PRODUCTION] ${serviceName} deploy complete ✅`
      );
      expect(content).toContain(`Service: ${serviceName}`);
    }
  );

  it('remembers a successful WEB deploy as an E2E reply target', async () => {
    dropCreationApiService.createDrop.mockResolvedValue({
      id: 'deploy-drop',
      parts: [{ part_id: 7 }]
    });
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any,
      releaseNotesQueue as any,
      alertTargetStore as any
    );

    await service.postAlert(
      {
        ...baseRequest,
        alert_type: 'deploy',
        status: 'success',
        title: 'WEB deploy complete',
        release_train_id: 'train-123'
      },
      {}
    );

    expect(alertTargetStore.rememberDeployTarget).toHaveBeenCalledWith(
      {
        repo: '6529seize-frontend',
        environment: 'prod',
        runId: '12345',
        releaseTrainId: 'train-123'
      },
      {
        dropId: 'deploy-drop',
        dropPartId: 7,
        sha: 'abc1234567890',
        triggeredByGithubLogin: 'prxt6529'
      }
    );
  });

  it('replies to the WEB deploy for an automatic E2E success', async () => {
    alertTargetStore.resolveDeployTarget.mockResolvedValue({
      dropId: 'deploy-drop',
      dropPartId: 7,
      sha: 'b'.repeat(40),
      triggeredByGithubLogin: 'prxt6529'
    });
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any,
      releaseNotesQueue as any,
      alertTargetStore as any
    );

    await service.postAlert(
      {
        ...baseRequest,
        alert_type: 'web_e2e',
        workflow: 'Production E2E',
        status: 'success',
        title: 'WEB E2E passed',
        triggered_by_github_login: 'github-actions[bot]',
        run_id: '900',
        run_number: '791',
        run_url:
          'https://github.com/6529-Collections/6529seize-frontend/actions/runs/900',
        run_attempt: 2,
        parent_deploy_run_id: '12345',
        validation_pack: 'all'
      },
      {}
    );

    expect(alertTargetStore.resolveDeployTarget).toHaveBeenCalledWith({
      repo: '6529seize-frontend',
      environment: 'prod',
      runId: '12345',
      releaseTrainId: null
    });
    expect(
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest
    ).toMatchObject({
      reply_to: { drop_id: 'deploy-drop', drop_part_id: 7 },
      mentioned_users: [],
      parts: [
        {
          content:
            '[🚀 PRODUCTION] WEB E2E passed ✅ [Run #791 (attempt 2)](https://github.com/6529-Collections/6529seize-frontend/actions/runs/900)'
        }
      ]
    });
    expect(identitiesRepository.getIdsByHandles).not.toHaveBeenCalled();
  });

  it('posts an unambiguous manual E2E failure as a sibling reply', async () => {
    identitiesRepository.getIdsByHandles.mockResolvedValue({
      ragne: 'profile-validator',
      prxt0: 'profile-initiator'
    });
    alertTargetStore.resolveDeployTarget.mockResolvedValue({
      dropId: 'deploy-drop',
      dropPartId: 7,
      sha: 'c'.repeat(40),
      triggeredByGithubLogin: 'prxt6529'
    });
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any,
      releaseNotesQueue as any,
      alertTargetStore as any
    );

    await service.postAlert(
      {
        ...baseRequest,
        alert_type: 'web_e2e',
        workflow: 'Staging E2E',
        title: 'WEB E2E failed',
        triggered_by_github_login: 'ragnep',
        run_attempt: 1,
        parent_release_train_id: 'train-123',
        validation_pack: 'core',
        environment: 'staging'
      },
      {}
    );

    const request =
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest;
    expect(request.reply_to).toEqual({
      drop_id: 'deploy-drop',
      drop_part_id: 7
    });
    expect(request.mentioned_users).toEqual([
      {
        mentioned_profile_id: 'profile-validator',
        handle_in_content: 'ragne'
      },
      {
        mentioned_profile_id: 'profile-initiator',
        handle_in_content: 'prxt0'
      }
    ]);
    expect(request.parts[0].content).toContain(
      [
        '[🚧 STAGING] WEB E2E failed 🚨',
        '',
        'Validation: Manual by @[ragne]',
        'Pack: core',
        'Deploy initiated by: @[prxt0]'
      ].join('\n')
    );
    expect(request.parts[0].content).toContain(
      'Run: [#6082](https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345)'
    );
    expect(request.parts[0].content).not.toContain('(attempt 1)');
    expect(request.parts[0].content.endsWith('\n\ncc @devs6529')).toBe(true);
  });

  it('posts a manual E2E success standalone when its deploy is ambiguous', async () => {
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any,
      releaseNotesQueue as any,
      alertTargetStore as any
    );

    await service.postAlert(
      {
        ...baseRequest,
        alert_type: 'web_e2e',
        workflow: 'Staging E2E',
        title: 'WEB E2E passed',
        status: 'success',
        triggered_by_github_login: 'ragnep',
        parent_deploy_run_id: null,
        parent_release_train_id: null,
        validation_pack: 'all',
        environment: 'staging'
      },
      {}
    );

    const request =
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest;
    expect(request).not.toHaveProperty('reply_to');
    expect(request.mentioned_users).toEqual([]);
    expect(request.parts[0].content).toBe(
      '[🚧 STAGING] WEB E2E passed ✅ [Run #6082](https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345)'
    );
    expect(identitiesRepository.getIdsByHandles).not.toHaveBeenCalled();
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

  it('does not render or notify train-wide contributors on each deployment', async () => {
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

    expect(identitiesRepository.getIdsByHandles).not.toHaveBeenCalled();
    const createDropRequest =
      dropCreationApiService.createDrop.mock.calls[0][0].createDropRequest;
    expect(createDropRequest.mentioned_users).toEqual([]);
    expect(createDropRequest.parts[0].content).toContain(
      'Initiated by: Release Train'
    );
    expect(createDropRequest.parts[0].content).not.toContain('Contributors:');
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
      triggered_by_github_login: baseRequest.triggered_by_github_login,
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

  it('enqueues exact Desktop release metadata from the production S3 milestone', async () => {
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any,
      releaseNotesQueue as any
    );
    const frontendSha = '63630a3e27c37296bbe39d9813b014a824265a56';

    await service.postAlert(
      {
        ...baseRequest,
        repo: '6529-core',
        workflow: 'Publish',
        service: 'desktop',
        status: 'success',
        release_notes_prompt_path:
          'ops/release-notes/desktop-release-notes.prompt.md',
        release_group_id: 'desktop-v0.3.13',
        release_group_services: ['desktop'],
        release_version: '0.3.13',
        frontend_sha: frontendSha,
        deployed_at: '2026-08-14T10:00:00.000Z'
      },
      {}
    );

    expect(releaseNotesQueue.enqueueBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: '6529-core',
        workflow: 'Publish',
        service: 'desktop',
        release_version: '0.3.13',
        frontend_sha: frontendSha,
        release_group_id: 'desktop-v0.3.13',
        release_group_services: ['desktop']
      })
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
        triggered_by_github_login: '6529-release-bus[bot]',
        release_train_id: 'train-123',
        contributor_github_logins: ['Alice', 'BOB', 'alice'],
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
        contributor_github_logins: ['Alice', 'BOB'],
        publish_release_note: true
      })
    );
    expect(releaseNotesQueue.enqueueBestEffort).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        release_group_id: 'pr-1802',
        release_group_services: ['api'],
        pull_request_number: 1802,
        contributor_github_logins: ['Alice', 'BOB'],
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
        '[🚀 PRODUCTION] Desktop Publish completed 🚀 ✅',
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
          '[🚀 PRODUCTION] Web Deploy - PROD 🚨'
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
    expect(content.startsWith('[🚀 PRODUCTION] Build succeeded ✅')).toBe(true);
    expect(content.startsWith('[🚀 PRODUCTION] Build succeeded ✅ ❌ 🚨')).toBe(
      false
    );
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
