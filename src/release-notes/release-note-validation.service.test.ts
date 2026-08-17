import { AiPrompter } from '@/abusiveness/ai-prompter';
import { DropCreationApiService } from '@/api/drops/drop-creation.api.service';
import { DropsDb } from '@/drops/drops.db';
import { IdentitiesDb } from '@/identities/identities.db';
import {
  ReleaseNoteGenerationRequest,
  ReleaseNoteValidationRequest
} from './release-note-generation-queue';
import { ReleaseNoteGitHubService } from './release-note-github.service';
import { ReleaseNoteGenerationService } from './release-note-generation.service';

const release: ReleaseNoteGenerationRequest = {
  repo: '6529-Collections/6529seize-frontend',
  workflow: 'Web Deploy - PROD',
  run_id: '123',
  run_number: '45',
  run_url: 'https://github.com/example/actions/runs/123',
  sha: 'a'.repeat(40),
  branch: 'main',
  environment: 'prod',
  service: 'web',
  prompt_path: 'ops/release-notes/release-notes.prompt.md',
  release_group_id: 'frontend-release',
  release_group_services: ['web'],
  pull_request_number: null,
  deployed_at: '2026-08-17T10:00:00.000Z'
};

const validation = (
  overrides: Partial<ReleaseNoteValidationRequest> = {}
): ReleaseNoteValidationRequest => ({
  message_type: 'release_validation',
  repo: release.repo,
  workflow: 'Production E2E',
  run_id: '456',
  run_number: '12',
  run_url: 'https://github.com/example/actions/runs/456',
  sha: release.sha,
  release_group_id: release.release_group_id,
  status: 'success',
  validation_mode: 'automatic',
  triggered_by_github_login: 'prxt6529',
  ...overrides
});

const service = ({
  getReleaseContext = jest.fn(),
  createDrop = jest.fn().mockResolvedValue({}),
  findDropIdByMetadata = jest.fn().mockResolvedValue(null),
  getIdsByHandles = jest.fn().mockResolvedValue({ prxt0: 'profile-prxt' })
} = {}) =>
  new ReleaseNoteGenerationService(
    { getReleaseContext } as unknown as ReleaseNoteGitHubService,
    {} as AiPrompter,
    { createDrop } as unknown as DropCreationApiService,
    { getIdsByHandles } as unknown as IdentitiesDb,
    undefined,
    { findDropIdByMetadata } as unknown as DropsDb
  );

describe('release-note validation lifecycle', () => {
  const originalEnv = {
    CI_PIPELINES_BOT_PROFILE_ID: process.env.CI_PIPELINES_BOT_PROFILE_ID,
    CI_RELEASES_WAVE_ID: process.env.CI_RELEASES_WAVE_ID
  };

  beforeAll(() => {
    process.env.CI_PIPELINES_BOT_PROFILE_ID = 'bot-profile';
    process.env.CI_RELEASES_WAVE_ID = 'release-wave';
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it.each([
    [null, 'No previous successful production deployment'],
    [{ pull_requests: [] }, 'No new merged pull requests']
  ])('publishes a parent deployment record for %p', async (context, text) => {
    const createDrop = jest.fn().mockResolvedValue({});
    const subject = service({
      getReleaseContext: jest.fn().mockResolvedValue(context),
      createDrop
    });

    await expect(subject.generateAndPost(release, {})).resolves.toBe(
      'published'
    );
    expect(
      createDrop.mock.calls[0][0].createDropRequest.parts[0].content
    ).toContain(text);
    expect(createDrop.mock.calls[0][0].createDropRequest.metadata).toEqual([
      expect.objectContaining({ data_key: 'release_note_id' })
    ]);
  });

  it.each([
    ['success', 'Post-deployment validation passed', false],
    ['failure', 'Post-deployment validation failed', true]
  ] as const)(
    'posts a threaded %s result beneath its release note',
    async (status, expectedText, mentionsDevs) => {
      const createDrop = jest.fn().mockResolvedValue({});
      const findDropIdByMetadata = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('release-note-drop');
      const subject = service({ createDrop, findDropIdByMetadata });

      await expect(
        subject.postValidationReply(validation({ status }), {})
      ).resolves.toBe('published');

      const request = createDrop.mock.calls[0][0].createDropRequest;
      expect(request.reply_to).toEqual({
        drop_id: 'release-note-drop',
        drop_part_id: 1
      });
      expect(request.parts[0].content).toContain(expectedText);
      expect(request.parts[0].content.includes('@devs6529')).toBe(mentionsDevs);
      expect(request.metadata).toEqual([
        expect.objectContaining({ data_key: 'release_note_validation_id' })
      ]);
    }
  );

  it('does not republish an already-recorded validation result', async () => {
    const createDrop = jest.fn();
    const findDropIdByMetadata = jest
      .fn()
      .mockResolvedValue('existing-validation-drop');
    const subject = service({ createDrop, findDropIdByMetadata });

    await expect(subject.postValidationReply(validation(), {})).resolves.toBe(
      'already-published'
    );
    expect(findDropIdByMetadata).toHaveBeenCalledTimes(1);
    expect(createDrop).not.toHaveBeenCalled();
  });

  it('fails for SQS retry while the parent release note is unavailable', async () => {
    const createDrop = jest.fn();
    const subject = service({ createDrop });

    await expect(subject.postValidationReply(validation(), {})).rejects.toThrow(
      'Release note is not published yet'
    );
    expect(createDrop).not.toHaveBeenCalled();
  });

  it('records manual recovery after an automatic failure in the same thread', async () => {
    const createDrop = jest.fn().mockResolvedValue({});
    const findDropIdByMetadata = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('release-note-drop')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('release-note-drop');
    const subject = service({ createDrop, findDropIdByMetadata });

    await subject.postValidationReply(validation({ status: 'failure' }), {});
    await subject.postValidationReply(
      validation({
        run_id: 'manual-run',
        run_url: 'https://github.com/example/manual-run',
        status: 'success',
        validation_mode: 'manual'
      }),
      {}
    );

    const contents = createDrop.mock.calls.map(
      (call) => call[0].createDropRequest.parts[0].content
    );
    expect(contents[0]).toContain('Post-deployment validation failed');
    expect(contents[0]).toContain('Deployment initiated by: @[prxt0]');
    expect(contents[0]).toContain('@devs6529');
    expect(contents[1]).toContain('Manual production revalidation passed');
    expect(contents[1]).not.toContain('@devs6529');
    expect(
      createDrop.mock.calls.map(
        (call) => call[0].createDropRequest.reply_to.drop_id
      )
    ).toEqual(['release-note-drop', 'release-note-drop']);
  });
});
