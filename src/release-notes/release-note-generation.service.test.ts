import { AiPrompter } from '@/abusiveness/ai-prompter';
import { DropCreationApiService } from '@/api/drops/drop-creation.api.service';
import { IdentitiesDb } from '@/identities/identities.db';
import { DropsDb } from '@/drops/drops.db';
import { ReleaseNoteGenerationRequest } from './release-note-generation-queue';
import {
  GitHubReleaseContext,
  ReleaseNoteGitHubService
} from './release-note-github.service';
import { ReleaseNoteGenerationService } from './release-note-generation.service';

const request: ReleaseNoteGenerationRequest = {
  repo: '6529-Collections/6529seize-backend',
  workflow: 'Deploy a service',
  run_id: '123',
  run_number: '45',
  run_url:
    'https://github.com/6529-Collections/6529seize-backend/actions/runs/123',
  sha: 'current-sha',
  branch: 'main',
  environment: 'prod',
  service: 'api',
  prompt_path: 'ops/release-notes/release-notes.prompt.md',
  release_group_id: 'backend-release',
  release_group_services: ['api', 'pushNotificationsHandler'],
  release_group_runs: [
    {
      service: 'api',
      run_id: '123',
      run_number: '45',
      run_url:
        'https://github.com/6529-Collections/6529seize-backend/actions/runs/123'
    },
    {
      service: 'pushNotificationsHandler',
      run_id: '456',
      run_number: '46',
      run_url:
        'https://github.com/6529-Collections/6529seize-backend/actions/runs/456'
    }
  ],
  deployed_at: '2026-07-13T11:38:00.000Z'
};

const context: GitHubReleaseContext = {
  previous_sha: 'previous-sha',
  current_sha: 'current-sha',
  pull_requests: [
    {
      number: 42,
      url: 'https://github.com/6529-Collections/6529seize-backend/pull/42',
      title: 'Improve notifications',
      body: 'Makes notification delivery more reliable.',
      contributors: ['Alice'],
      commit_messages: ['Improve notifications'],
      changed_files: [
        {
          filename: 'src/api-serverless/src/notifications/routes.ts',
          additions: 10,
          deletions: 2,
          changes: 12
        }
      ],
      candidate_services: ['api']
    }
  ]
};

function createDropsRepository(existingDropId: string | null = null): DropsDb {
  return {
    findDropIdByMetadata: jest.fn().mockResolvedValue(existingDropId)
  } as unknown as DropsDb;
}

describe('ReleaseNoteGenerationService', () => {
  const originalBotProfileId = process.env.CI_PIPELINES_BOT_PROFILE_ID;
  const originalWaveId = process.env.CI_RELEASES_WAVE_ID;

  beforeEach(() => {
    process.env.CI_PIPELINES_BOT_PROFILE_ID = 'bot-profile';
    process.env.CI_RELEASES_WAVE_ID = 'releases-wave';
  });

  afterAll(() => {
    if (originalBotProfileId === undefined) {
      delete process.env.CI_PIPELINES_BOT_PROFILE_ID;
    } else {
      process.env.CI_PIPELINES_BOT_PROFILE_ID = originalBotProfileId;
    }
    if (originalWaveId === undefined) {
      delete process.env.CI_RELEASES_WAVE_ID;
    } else {
      process.env.CI_RELEASES_WAVE_ID = originalWaveId;
    }
  });

  it('renders validated summaries, service labels, PR links, and 6529 mentions', async () => {
    const getReleaseContext = jest.fn().mockResolvedValue(context);
    const getReleasePrompt = jest.fn().mockResolvedValue('Repository prompt.');
    const promptAndGetReply = jest.fn().mockResolvedValue(
      `\`\`\`json\n${JSON.stringify({
        pull_requests: [
          {
            number: 42,
            summary: 'Made notification delivery more reliable.'
          }
        ]
      })}\n\`\`\``
    );
    const createDrop = jest.fn().mockResolvedValue({});
    const getIdsByHandles = jest
      .fn()
      .mockResolvedValue({ alice6529: 'alice-profile' });
    const service = new ReleaseNoteGenerationService(
      {
        getReleaseContext,
        getReleasePrompt
      } as unknown as ReleaseNoteGitHubService,
      { promptAndGetReply } as AiPrompter,
      { createDrop } as unknown as DropCreationApiService,
      { getIdsByHandles } as unknown as IdentitiesDb,
      { alice: 'alice6529' },
      createDropsRepository()
    );

    await service.generateAndPost(request, {});

    expect(promptAndGetReply).toHaveBeenCalledWith(
      expect.stringContaining('<release_context>')
    );
    expect(createDrop).toHaveBeenCalledWith(
      expect.objectContaining({
        authorId: 'bot-profile',
        representativeId: 'bot-profile',
        hideLinkPreview: true,
        createDropRequest: expect.objectContaining({
          wave_id: 'releases-wave',
          metadata: [
            {
              data_key: 'release_note_id',
              data_value: expect.stringMatching(/^[0-9a-f]{64}$/)
            }
          ],
          mentioned_users: [
            {
              mentioned_profile_id: 'alice-profile',
              handle_in_content: 'alice6529'
            }
          ],
          parts: [
            expect.objectContaining({
              content: expect.stringContaining(
                '- [PR #42](https://github.com/6529-Collections/6529seize-backend/pull/42): Made notification delivery more reliable. - @[alice6529] — Service: api'
              )
            })
          ]
        })
      }),
      expect.any(Object)
    );
    const content =
      createDrop.mock.calls[0][0].createDropRequest.parts[0].content;
    expect(content).toContain(
      '### Backend deploy · commit [current-](https://github.com/6529-Collections/6529seize-backend/commit/current-sha) — Jul 13, 11:38 AM UTC'
    );
    expect(content).toContain(
      'Runs: [api #45](https://github.com/6529-Collections/6529seize-backend/actions/runs/123), [pushNotificationsHandler #46](https://github.com/6529-Collections/6529seize-backend/actions/runs/456)'
    );
    expect(content).not.toContain('Services affected:');
  });

  it('renders repository-specific single-service run links', async () => {
    const createDrop = jest.fn().mockResolvedValue({});
    const service = new ReleaseNoteGenerationService(
      {
        getReleaseContext: jest.fn().mockResolvedValue(context),
        getReleasePrompt: jest.fn().mockResolvedValue('Repository prompt.')
      } as unknown as ReleaseNoteGitHubService,
      {
        promptAndGetReply: jest.fn().mockResolvedValue(
          JSON.stringify({
            pull_requests: [
              {
                number: 42,
                summary: 'Made notification delivery more reliable.'
              }
            ]
          })
        )
      },
      { createDrop } as unknown as DropCreationApiService,
      {
        getIdsByHandles: jest.fn().mockResolvedValue({})
      } as unknown as IdentitiesDb,
      {},
      createDropsRepository()
    );

    await service.generateAndPost(
      {
        ...request,
        repo: '6529-Collections/6529seize-frontend',
        service: 'web',
        release_group_id: 'frontend-release',
        release_group_services: ['web'],
        release_group_runs: undefined
      },
      {}
    );

    const content =
      createDrop.mock.calls[0][0].createDropRequest.parts[0].content;
    expect(content).toContain(
      '### Frontend deploy [#45](https://github.com/6529-Collections/6529seize-backend/actions/runs/123) · commit [current-](https://github.com/6529-Collections/6529seize-frontend/commit/current-sha) — Jul 13, 11:38 AM UTC'
    );
    expect(content).not.toContain('[Frontend deploy #45]');

    await service.generateAndPost(
      {
        ...request,
        release_group_services: ['api'],
        release_group_runs: undefined
      },
      {}
    );

    const backendContent =
      createDrop.mock.calls[1][0].createDropRequest.parts[0].content;
    expect(backendContent).toContain(
      '### Backend deploy [api #45](https://github.com/6529-Collections/6529seize-backend/actions/runs/123) · commit [current-](https://github.com/6529-Collections/6529seize-backend/commit/current-sha) — Jul 13, 11:38 AM UTC'
    );
  });

  it('rejects a model response that omits a pull request', async () => {
    const service = new ReleaseNoteGenerationService(
      {
        getReleaseContext: jest.fn().mockResolvedValue(context),
        getReleasePrompt: jest.fn().mockResolvedValue('Repository prompt.')
      } as unknown as ReleaseNoteGitHubService,
      {
        promptAndGetReply: jest
          .fn()
          .mockResolvedValue(JSON.stringify({ pull_requests: [] }))
      },
      { createDrop: jest.fn() } as unknown as DropCreationApiService,
      { getIdsByHandles: jest.fn() } as unknown as IdentitiesDb,
      undefined,
      createDropsRepository()
    );

    await expect(service.generateAndPost(request, {})).rejects.toThrow(
      'did not include every pull request'
    );
  });

  it('renders sorted unique service labels for a multi-service pull request', async () => {
    const createDrop = jest.fn().mockResolvedValue({});
    const multiServiceContext: GitHubReleaseContext = {
      ...context,
      pull_requests: [
        {
          ...context.pull_requests[0],
          candidate_services: ['pushNotificationsHandler', 'api', 'api']
        }
      ]
    };
    const service = new ReleaseNoteGenerationService(
      {
        getReleaseContext: jest.fn().mockResolvedValue(multiServiceContext),
        getReleasePrompt: jest.fn().mockResolvedValue('Repository prompt.')
      } as unknown as ReleaseNoteGitHubService,
      {
        promptAndGetReply: jest.fn().mockResolvedValue(
          JSON.stringify({
            pull_requests: [
              {
                number: 42,
                summary: 'Made notification delivery more reliable.'
              }
            ]
          })
        )
      },
      { createDrop } as unknown as DropCreationApiService,
      {
        getIdsByHandles: jest.fn().mockResolvedValue({})
      } as unknown as IdentitiesDb,
      {},
      createDropsRepository()
    );

    await service.generateAndPost(
      {
        ...request,
        release_group_runs: request.release_group_runs?.slice(0, 1)
      },
      {}
    );

    const content =
      createDrop.mock.calls[0][0].createDropRequest.parts[0].content;
    expect(content).toContain('— Services: api, pushNotificationsHandler');
    expect(content).not.toContain('\nRuns:');
  });

  it('neutralizes model-supplied markdown and mention syntax', async () => {
    const createDrop = jest.fn().mockResolvedValue({});
    const service = new ReleaseNoteGenerationService(
      {
        getReleaseContext: jest.fn().mockResolvedValue(context),
        getReleasePrompt: jest.fn().mockResolvedValue('Repository prompt.')
      } as unknown as ReleaseNoteGitHubService,
      {
        promptAndGetReply: jest.fn().mockResolvedValue(
          JSON.stringify({
            pull_requests: [
              {
                number: 42,
                summary:
                  'Improved delivery with [details](https://example.com), @[mallory], and *bold* text.'
              }
            ]
          })
        )
      },
      { createDrop } as unknown as DropCreationApiService,
      {
        getIdsByHandles: jest.fn().mockResolvedValue({})
      } as unknown as IdentitiesDb,
      {},
      createDropsRepository()
    );

    await service.generateAndPost(request, {});

    const content =
      createDrop.mock.calls[0][0].createDropRequest.parts[0].content;
    expect(content).not.toContain('[details]');
    expect(content).not.toContain('@[mallory]');
    expect(content).not.toContain('*bold*');
  });

  it('compacts oversized release context while retaining every pull request', async () => {
    const pullRequests = Array.from({ length: 20 }, (_, index) => ({
      ...context.pull_requests[0],
      number: index + 1,
      url: `https://github.com/6529-Collections/6529seize-backend/pull/${index + 1}`,
      title: `Release change ${index + 1}`,
      body: 'x'.repeat(12000),
      contributors: [],
      commit_messages: [`Release change ${index + 1}`]
    }));
    const promptAndGetReply = jest.fn().mockResolvedValue(
      JSON.stringify({
        pull_requests: pullRequests.map((pullRequest) => ({
          number: pullRequest.number,
          summary: `Summarized change ${pullRequest.number}.`
        }))
      })
    );
    const createDrop = jest.fn().mockResolvedValue({});
    const service = new ReleaseNoteGenerationService(
      {
        getReleaseContext: jest.fn().mockResolvedValue({
          ...context,
          pull_requests: pullRequests
        }),
        getReleasePrompt: jest.fn().mockResolvedValue('Repository prompt.')
      } as unknown as ReleaseNoteGitHubService,
      { promptAndGetReply } as AiPrompter,
      { createDrop } as unknown as DropCreationApiService,
      {
        getIdsByHandles: jest.fn().mockResolvedValue({})
      } as unknown as IdentitiesDb,
      {},
      createDropsRepository()
    );

    const outcome = await service.generateAndPost(request, {});

    const prompt = promptAndGetReply.mock.calls[0][0] as string;
    expect(outcome).toBe('published');
    expect(prompt.length).toBeLessThan(200000);
    expect(prompt).toContain('Release change 20');
    expect(prompt).not.toContain('x'.repeat(3000));
    expect(createDrop).toHaveBeenCalledTimes(1);
  });

  it('skips generation when the release drop already exists', async () => {
    const getReleaseContext = jest.fn();
    const promptAndGetReply = jest.fn();
    const createDrop = jest.fn();
    const service = new ReleaseNoteGenerationService(
      { getReleaseContext } as unknown as ReleaseNoteGitHubService,
      { promptAndGetReply } as AiPrompter,
      { createDrop } as unknown as DropCreationApiService,
      { getIdsByHandles: jest.fn() } as unknown as IdentitiesDb,
      undefined,
      createDropsRepository('existing-drop')
    );

    const outcome = await service.generateAndPost(request, {});

    expect(outcome).toBe('already-published');
    expect(getReleaseContext).not.toHaveBeenCalled();
    expect(promptAndGetReply).not.toHaveBeenCalled();
    expect(createDrop).not.toHaveBeenCalled();
  });

  it('reports a missing baseline without generating content', async () => {
    const getReleaseContext = jest.fn().mockResolvedValue(null);
    const getReleasePrompt = jest.fn();
    const promptAndGetReply = jest.fn();
    const createDrop = jest.fn();
    const service = new ReleaseNoteGenerationService(
      {
        getReleaseContext,
        getReleasePrompt
      } as unknown as ReleaseNoteGitHubService,
      { promptAndGetReply } as AiPrompter,
      { createDrop } as unknown as DropCreationApiService,
      { getIdsByHandles: jest.fn() } as unknown as IdentitiesDb,
      undefined,
      createDropsRepository()
    );

    const outcome = await service.generateAndPost(request, {});

    expect(outcome).toBe('no-baseline');
    expect(getReleasePrompt).not.toHaveBeenCalled();
    expect(promptAndGetReply).not.toHaveBeenCalled();
    expect(createDrop).not.toHaveBeenCalled();
  });
});
