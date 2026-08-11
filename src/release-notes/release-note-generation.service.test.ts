jest.mock('node-fetch', () => ({
  __esModule: true,
  default: jest.fn()
}));

import { AiPrompter } from '@/abusiveness/ai-prompter';
import { DropCreationApiService } from '@/api/drops/drop-creation.api.service';
import { CiPipelineAlertService } from '@/api-serverless/src/ci-pipeline-alerts/ci-pipeline-alert.service';
import { IdentitiesDb } from '@/identities/identities.db';
import { DropsDb } from '@/drops/drops.db';
import fetch from 'node-fetch';
import { ReleaseNoteGenerationRequest } from './release-note-generation-queue';
import {
  AlreadyDeployedReleaseShaError,
  GitHubReleaseContext,
  NonForwardReleaseRangeError,
  ReleaseNoteGitHubService
} from './release-note-github.service';
import { ReleaseNoteGenerationService } from './release-note-generation.service';
import { parseReleaseNoteMessage } from '@/releaseNotesGenerationLoop';

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
  pull_request_number: 42,
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
  const originalProdWaveId = process.env.CI_PIPELINES_PROD_WAVE_ID;
  const originalGithubToken = process.env.RELEASE_NOTES_GITHUB_TOKEN;

  beforeEach(() => {
    process.env.CI_PIPELINES_BOT_PROFILE_ID = 'bot-profile';
    process.env.CI_RELEASES_WAVE_ID = 'releases-wave';
    process.env.CI_PIPELINES_PROD_WAVE_ID = 'prod-wave';
    process.env.RELEASE_NOTES_GITHUB_TOKEN = 'github-token';
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
    if (originalProdWaveId === undefined) {
      delete process.env.CI_PIPELINES_PROD_WAVE_ID;
    } else {
      process.env.CI_PIPELINES_PROD_WAVE_ID = originalProdWaveId;
    }
    if (originalGithubToken === undefined) {
      delete process.env.RELEASE_NOTES_GITHUB_TOKEN;
    } else {
      process.env.RELEASE_NOTES_GITHUB_TOKEN = originalGithubToken;
    }
  });

  it('carries frontend run #15 from an accepted CI alert through the exact baseline to a published PR-scoped release note', async () => {
    const deployedSha = '9d85844ca9c63274083612f211463d31588ae954';
    let queuedRequest: ReleaseNoteGenerationRequest | null = null;
    const ciDropCreation = {
      createDrop: jest.fn().mockResolvedValue({ id: 'ci-drop' }),
      toggleHideLinkPreview: jest.fn().mockResolvedValue({})
    };
    const alertService = new CiPipelineAlertService(
      ciDropCreation as unknown as DropCreationApiService,
      {
        getIdsByHandles: jest
          .fn()
          .mockResolvedValue({ prxt0: 'initiator-profile' })
      } as unknown as IdentitiesDb,
      {
        enqueueBestEffort: jest
          .fn()
          .mockImplementation((value: ReleaseNoteGenerationRequest) => {
            queuedRequest = value;
            return Promise.resolve('enqueued');
          })
      } as any
    );

    await expect(
      alertService.postAlert(
        {
          repo: '6529seize-frontend',
          workflow: 'Release Bus - Deploy Frontend Production',
          status: 'success',
          title: 'Frontend production deployment complete',
          triggered_by_github_login: '6529-release-bus[bot]',
          run_id: '30379747148',
          run_number: '15',
          run_url:
            'https://github.com/6529-Collections/6529seize-frontend/actions/runs/30379747148',
          sha: deployedSha,
          branch: 'main',
          environment: 'prod',
          service: 'web',
          release_train_id: 'a7d3433d-e145-4578-bc78-e96fbd34f591',
          release_operation_key:
            'rb2:a7d3433d-e145-4578-bc78-e96fbd34f591:deploy:prod:frontend:a1',
          contributor_evidence: 'release-bus-operation',
          contributor_github_logins: ['prxt6529'],
          release_notes_prompt_path:
            'ops/release-notes/release-notes.prompt.md',
          release_group_id: 'frontend:run-15',
          release_group_services: ['web'],
          deployed_at: '2026-07-23T11:38:00.000Z'
        },
        {}
      )
    ).resolves.toEqual({
      ci_drop: 'accepted',
      release_note: 'enqueued'
    });
    expect(queuedRequest).not.toBeNull();

    const githubResponse = (payload: unknown) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: jest.fn().mockReturnValue(null) },
      json: jest.fn().mockResolvedValue(payload)
    });
    const currentRun = {
      id: 30379747148,
      name: 'Release Bus - Deploy Frontend Production',
      display_title: 'Deploy frontend production train',
      head_sha: deployedSha,
      head_branch: 'main',
      run_number: 15,
      workflow_id: 99,
      status: 'in_progress',
      conclusion: null,
      created_at: '2026-07-23T11:38:00Z',
      path: '.github/workflows/release-bus-deploy-production.yml@refs/heads/main'
    };
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce(githubResponse(currentRun))
      .mockResolvedValueOnce(githubResponse({ workflow_runs: [] }))
      .mockResolvedValueOnce(
        githubResponse({
          workflow_runs: [
            {
              ...currentRun,
              id: 30370000000,
              head_sha: '8'.repeat(40),
              run_number: 14,
              status: 'completed',
              conclusion: 'success',
              created_at: '2026-07-22T11:38:00Z'
            }
          ]
        })
      )
      .mockResolvedValueOnce(
        githubResponse({
          commits: [
            {
              sha: deployedSha,
              author: { login: 'prxt6529', type: 'User' },
              committer: { login: 'web-flow', type: 'User' },
              commit: {
                message: 'Restore Release Bus frontend release notes'
              }
            }
          ],
          total_commits: 1,
          status: 'ahead'
        })
      )
      .mockResolvedValueOnce(
        githubResponse([
          {
            number: 3498,
            html_url:
              'https://github.com/6529-Collections/6529seize-frontend/pull/3498',
            title: 'Restore Release Bus frontend production release notes',
            body: 'Restore the reviewed prompt path.',
            merged_at: '2026-07-23T10:00:00Z',
            user: { login: 'prxt6529', type: 'User' },
            base: { ref: 'main' }
          }
        ])
      )
      .mockResolvedValueOnce(
        githubResponse([
          {
            filename: '.github/workflows/release-bus-deploy-production.yml',
            additions: 1,
            deletions: 0,
            changes: 1
          }
        ])
      )
      .mockResolvedValueOnce(
        githubResponse([
          {
            sha: deployedSha,
            author: { login: 'prxt6529', type: 'User' },
            committer: { login: 'web-flow', type: 'User' }
          }
        ])
      )
      .mockResolvedValueOnce(
        githubResponse({
          type: 'file',
          encoding: 'base64',
          content: Buffer.from('Reviewed repository prompt.').toString('base64')
        })
      );

    const releaseDropCreation = {
      createDrop: jest.fn().mockResolvedValue({ id: 'release-note-drop' })
    };
    const generationService = new ReleaseNoteGenerationService(
      new ReleaseNoteGitHubService(),
      {
        promptAndGetReply: jest.fn().mockResolvedValue(
          JSON.stringify({
            pull_requests: [
              {
                number: 3498,
                summary: 'Restored frontend production release notes.'
              }
            ]
          })
        )
      } as AiPrompter,
      releaseDropCreation as unknown as DropCreationApiService,
      {
        getIdsByHandles: jest
          .fn()
          .mockResolvedValue({ prxt0: 'contributor-profile' })
      } as unknown as IdentitiesDb,
      { prxt6529: 'prxt0' },
      createDropsRepository()
    );
    const parsedRequest = parseReleaseNoteMessage(
      JSON.stringify(queuedRequest)
    );

    await expect(
      generationService.generateAndPost(parsedRequest, {})
    ).resolves.toBe('published');
    expect(releaseDropCreation.createDrop).toHaveBeenCalledWith(
      expect.objectContaining({
        createDropRequest: expect.objectContaining({
          parts: [
            expect.objectContaining({
              content: expect.stringContaining(
                'https://github.com/6529-Collections/6529seize-frontend/pull/3498'
              )
            })
          ],
          mentioned_users: [
            {
              mentioned_profile_id: 'contributor-profile',
              handle_in_content: 'prxt0'
            }
          ]
        })
      }),
      expect.any(Object)
    );
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
                '[PR #42](https://github.com/6529-Collections/6529seize-backend/pull/42): Made notification delivery more reliable. - @[alice6529]\n- Service: [api #45](https://github.com/6529-Collections/6529seize-backend/actions/runs/123)'
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
      '### Backend Deploy · commit [current-](https://github.com/6529-Collections/6529seize-backend/commit/current-sha) — Jul 13, 11:38 AM UTC'
    );
    expect(content).not.toContain('\n\n- Service:');
    expect(content).not.toContain('Runs:');
    expect(content).not.toContain('Services affected:');
  });

  it('renders mapped and unmapped contributors once with correct mention metadata', async () => {
    const createDrop = jest.fn().mockResolvedValue({});
    const service = new ReleaseNoteGenerationService(
      {
        getReleaseContext: jest.fn().mockResolvedValue({
          ...context,
          pull_requests: [
            {
              ...context.pull_requests[0],
              contributors: ['Alice', 'Bob', 'BOB', 'AliceAlias']
            }
          ]
        }),
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
        getIdsByHandles: jest
          .fn()
          .mockResolvedValue({ alice6529: 'alice-profile' })
      } as unknown as IdentitiesDb,
      { alice: 'alice6529', alicealias: 'alice6529' },
      createDropsRepository()
    );

    await service.generateAndPost(request, {});

    const createDropRequest = createDrop.mock.calls[0][0].createDropRequest;
    expect(createDropRequest.parts[0].content).toContain(
      ' - @[alice6529], [@Bob](https://github.com/Bob)'
    );
    expect(createDropRequest.parts[0].content).not.toContain('@BOB');
    expect(createDropRequest.parts[0].content).not.toContain('AliceAlias');
    expect(createDropRequest.mentioned_users).toEqual([
      {
        mentioned_profile_id: 'alice-profile',
        handle_in_content: 'alice6529'
      }
    ]);
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
        pull_request_number: null,
        release_group_runs: undefined
      },
      {}
    );

    const content =
      createDrop.mock.calls[0][0].createDropRequest.parts[0].content;
    expect(content).toContain(
      '### Frontend Deploy [#45](https://github.com/6529-Collections/6529seize-backend/actions/runs/123) · commit [current-](https://github.com/6529-Collections/6529seize-frontend/commit/current-sha) — Jul 13, 11:38 AM UTC'
    );
    expect(content).not.toContain('[Frontend Deploy #45]');

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
      '### Backend Deploy · commit [current-](https://github.com/6529-Collections/6529seize-backend/commit/current-sha) — Jul 13, 11:38 AM UTC'
    );
    expect(backendContent).toContain(
      '- Service: [api #45](https://github.com/6529-Collections/6529seize-backend/actions/runs/123)'
    );
  });

  it('renders multi-PR backend notes as paragraphs with adjacent service bullets', async () => {
    const multiPullRequestContext: GitHubReleaseContext = {
      ...context,
      pull_requests: [
        context.pull_requests[0],
        {
          ...context.pull_requests[0],
          number: 43,
          url: 'https://github.com/6529-Collections/6529seize-backend/pull/43',
          title: 'Improve push notifications',
          contributors: [],
          candidate_services: ['pushNotificationsHandler']
        }
      ]
    };
    const createDrop = jest.fn().mockResolvedValue({});
    const service = new ReleaseNoteGenerationService(
      {
        getReleaseContext: jest.fn().mockResolvedValue(multiPullRequestContext),
        getReleasePrompt: jest.fn().mockResolvedValue('Repository prompt.')
      } as unknown as ReleaseNoteGitHubService,
      {
        promptAndGetReply: jest.fn().mockResolvedValue(
          JSON.stringify({
            pull_requests: [
              {
                number: 42,
                summary: 'Made notification delivery more reliable.'
              },
              {
                number: 43,
                summary: 'Improved push notification delivery.'
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
    expect(content).toContain(
      '[PR #42](https://github.com/6529-Collections/6529seize-backend/pull/42): Made notification delivery more reliable. - [@Alice](https://github.com/Alice)\n- Service: [api #45](https://github.com/6529-Collections/6529seize-backend/actions/runs/123)\n\n[PR #43](https://github.com/6529-Collections/6529seize-backend/pull/43): Improved push notification delivery.\n- Service: [pushNotificationsHandler #46](https://github.com/6529-Collections/6529seize-backend/actions/runs/456)'
    );
  });

  it('falls back to grouped service run links when service candidates are empty', async () => {
    const createDrop = jest.fn().mockResolvedValue({});
    const service = new ReleaseNoteGenerationService(
      {
        getReleaseContext: jest.fn().mockResolvedValue({
          ...context,
          pull_requests: [
            {
              ...context.pull_requests[0],
              candidate_services: []
            }
          ]
        }),
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

    await service.generateAndPost(request, {});

    const content =
      createDrop.mock.calls[0][0].createDropRequest.parts[0].content;
    expect(content).toContain(
      '- Services: [api #45](https://github.com/6529-Collections/6529seize-backend/actions/runs/123), [pushNotificationsHandler #46](https://github.com/6529-Collections/6529seize-backend/actions/runs/456)'
    );
  });

  it('falls back to sanitized PR titles when generated notes are invalid', async () => {
    const createDrop = jest.fn().mockResolvedValue({});
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
      { createDrop } as unknown as DropCreationApiService,
      {
        getIdsByHandles: jest.fn().mockResolvedValue({})
      } as unknown as IdentitiesDb,
      undefined,
      createDropsRepository()
    );

    await expect(service.generateAndPost(request, {})).resolves.toBe(
      'published'
    );
    expect(
      createDrop.mock.calls[0][0].createDropRequest.parts[0].content
    ).toContain(
      '[PR #42](https://github.com/6529-Collections/6529seize-backend/pull/42): Improve notifications'
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
    expect(content).toContain(
      '- Services: [api #45](https://github.com/6529-Collections/6529seize-backend/actions/runs/123), pushNotificationsHandler'
    );
    expect(content).not.toContain('Runs:');
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

  it('uses one publication identity for a PR across service SHAs', async () => {
    const findDropIdByMetadata = jest.fn().mockResolvedValue('existing-drop');
    const service = new ReleaseNoteGenerationService(
      {} as ReleaseNoteGitHubService,
      {} as AiPrompter,
      {} as DropCreationApiService,
      {} as IdentitiesDb,
      undefined,
      { findDropIdByMetadata } as unknown as DropsDb
    );

    await service.generateAndPost(request, {});
    await service.generateAndPost(
      {
        ...request,
        sha: 'later-service-sha',
        release_group_id: 'another-deploy-attempt'
      },
      {}
    );

    const firstPublicationId = findDropIdByMetadata.mock.calls[0][0].dataValue;
    const secondPublicationId = findDropIdByMetadata.mock.calls[1][0].dataValue;
    expect(secondPublicationId).toBe(firstPublicationId);
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

  it('reports an already-deployed frontend SHA without generating content', async () => {
    const getReleaseContext = jest
      .fn()
      .mockRejectedValue(
        new AlreadyDeployedReleaseShaError('current-sha', 122)
      );
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

    expect(outcome).toBe('already-deployed');
    expect(getReleasePrompt).not.toHaveBeenCalled();
    expect(promptAndGetReply).not.toHaveBeenCalled();
    expect(createDrop).not.toHaveBeenCalled();
  });

  it('reports a non-forward production range without generating content', async () => {
    const getReleaseContext = jest
      .fn()
      .mockRejectedValue(
        new NonForwardReleaseRangeError(
          'previous-sha',
          'current-sha',
          'diverged'
        )
      );
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

    expect(outcome).toBe('invalid-range');
    expect(getReleasePrompt).not.toHaveBeenCalled();
    expect(promptAndGetReply).not.toHaveBeenCalled();
    expect(createDrop).not.toHaveBeenCalled();
  });
});
