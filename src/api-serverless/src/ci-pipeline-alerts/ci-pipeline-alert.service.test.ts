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

import { CiPipelineAlertService } from './ci-pipeline-alert.service';

const baseRequest = {
  repo: '6529seize-frontend',
  workflow: 'Web Deploy - PROD',
  status: 'failure' as const,
  title: 'Seize PROD WEB DEPLOY: CI pipeline is broken!!!',
  description: 'abc123 - Fix deploy',
  run_id: '12345',
  run_url:
    'https://github.com/6529-Collections/6529seize-frontend/actions/runs/12345',
  sha: 'abc123',
  branch: 'main',
  environment: 'production',
  service: 'web'
};

describe('CiPipelineAlertService', () => {
  let originalEnv: Record<string, string | undefined>;
  let dropCreationApiService: { createDrop: jest.Mock };
  let identitiesRepository: { getIdsByHandles: jest.Mock };

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
      '@alice, @[Bob], alice, missing';
    dropCreationApiService = {
      createDrop: jest.fn().mockResolvedValue({})
    };
    identitiesRepository = {
      getIdsByHandles: jest.fn().mockResolvedValue({
        alice: 'profile-1',
        Bob: 'profile-2'
      })
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

  it('posts failures with configured profile mentions', async () => {
    const service = new CiPipelineAlertService(
      dropCreationApiService as any,
      identitiesRepository as any
    );
    const ctx = { connection: {} };

    await service.postAlert(baseRequest, ctx as any);

    expect(identitiesRepository.getIdsByHandles).toHaveBeenCalledWith(
      ['alice', 'Bob', 'missing'],
      ctx.connection
    );
    expect(dropCreationApiService.createDrop).toHaveBeenCalledWith(
      expect.objectContaining({
        authorId: 'bot-profile',
        representativeId: 'bot-profile',
        createDropRequest: expect.objectContaining({
          wave_id: 'prod-wave',
          title: 'CI failure: Seize PROD WEB DEPLOY: CI pipeline is broken!!!',
          mentioned_users: [
            {
              mentioned_profile_id: 'profile-1',
              handle_in_content: 'alice'
            },
            {
              mentioned_profile_id: 'profile-2',
              handle_in_content: 'Bob'
            }
          ],
          parts: [
            expect.objectContaining({
              content: expect.stringContaining('cc @[alice] @[Bob]')
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
  });

  it('routes staging successes without resolving or adding mentions', async () => {
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

    expect(identitiesRepository.getIdsByHandles).not.toHaveBeenCalled();
    expect(dropCreationApiService.createDrop).toHaveBeenCalledWith(
      expect.objectContaining({
        createDropRequest: expect.objectContaining({
          wave_id: 'staging-wave',
          mentioned_users: [],
          parts: [
            expect.objectContaining({
              content: expect.not.stringContaining('cc @[')
            })
          ]
        })
      }),
      expect.anything()
    );
  });
});
