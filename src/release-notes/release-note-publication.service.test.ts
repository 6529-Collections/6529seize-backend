import { ReleaseNotePublicationStatus } from '@/entities/IReleaseNotePublication';
import { ReleaseNoteGenerationRequest } from './release-note-generation-queue';
import { ReleaseNoteGitHubService } from './release-note-github.service';
import { ReleaseNotePublicationDb } from './release-note-publication.db';
import { ReleaseNotePublicationService } from './release-note-publication.service';

const request: ReleaseNoteGenerationRequest = {
  repo: '6529-Collections/6529seize-frontend',
  workflow: 'Web Deploy - PROD',
  run_id: '32471443637',
  run_number: '1660',
  run_url:
    'https://github.com/6529-Collections/6529seize-frontend/actions/runs/32471443637',
  sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  branch: 'main',
  environment: 'prod',
  service: 'web',
  prompt_path: 'ops/release-notes/release-notes.prompt.md',
  release_group_id: 'frontend-production',
  release_group_services: ['web'],
  deployed_at: '2026-08-21T09:00:00.000Z'
};

const currentRun = {
  id: request.run_id,
  run_number: 1660,
  workflow_id: '7',
  sha: request.sha
};

const previousRun = {
  id: '32470000000',
  run_number: 1659,
  workflow_id: '7',
  sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
};

function publication(status: ReleaseNotePublicationStatus) {
  return {
    publication_id: 'publication-id',
    stream_key: expect.any(String),
    current_run_id: currentRun.id,
    current_run_number: currentRun.run_number,
    current_sha: currentRun.sha,
    previous_run_id: previousRun.id,
    previous_run_number: previousRun.run_number,
    previous_sha: previousRun.sha,
    status,
    total_parts: null,
    next_part: 1,
    last_drop_id: null,
    created_at: 1,
    updated_at: 1,
    completed_at: null
  };
}

describe('ReleaseNotePublicationService', () => {
  it('bootstraps an empty stream from the bounded previous GitHub run', async () => {
    const findStreamState = jest.fn().mockResolvedValue(null);
    const preparePublication = jest.fn().mockImplementation(async (input) => ({
      ...publication(ReleaseNotePublicationStatus.Pending),
      stream_key: input.stream.key
    }));
    const getPreviousSuccessfulReleaseRun = jest
      .fn()
      .mockResolvedValue(previousRun);
    const service = new ReleaseNotePublicationService(
      {
        findStreamState,
        preparePublication
      } as unknown as ReleaseNotePublicationDb,
      {
        getValidatedReleaseRun: jest.fn().mockResolvedValue(currentRun),
        getPreviousSuccessfulReleaseRun
      } as unknown as ReleaseNoteGitHubService
    );

    await expect(
      service.prepare(request, 'publication-id', {})
    ).resolves.toEqual({
      publicationId: 'publication-id',
      previousSha: previousRun.sha,
      completed: false
    });
    expect(getPreviousSuccessfulReleaseRun).toHaveBeenCalledWith(
      request,
      currentRun
    );
    expect(preparePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        publicationId: 'publication-id',
        currentRun: {
          id: currentRun.id,
          number: currentRun.run_number,
          sha: currentRun.sha
        },
        bootstrapPreviousRun: {
          id: previousRun.id,
          number: previousRun.run_number,
          sha: previousRun.sha
        }
      }),
      {}
    );
  });

  it('uses the durable stream without scanning workflow history', async () => {
    const preparePublication = jest.fn().mockImplementation(async (input) => ({
      ...publication(ReleaseNotePublicationStatus.Publishing),
      stream_key: input.stream.key
    }));
    const getPreviousSuccessfulReleaseRun = jest.fn();
    const service = new ReleaseNotePublicationService(
      {
        findStreamState: jest.fn().mockResolvedValue({
          last_completed_run_id: previousRun.id,
          last_completed_run_number: previousRun.run_number,
          last_completed_sha: previousRun.sha
        }),
        preparePublication
      } as unknown as ReleaseNotePublicationDb,
      {
        getValidatedReleaseRun: jest.fn().mockResolvedValue(currentRun),
        getPreviousSuccessfulReleaseRun
      } as unknown as ReleaseNoteGitHubService
    );

    const prepared = await service.prepare(request, 'publication-id', {});

    expect(prepared?.previousSha).toBe(previousRun.sha);
    expect(getPreviousSuccessfulReleaseRun).not.toHaveBeenCalled();
    expect(preparePublication.mock.calls[0][0].bootstrapPreviousRun).toBeNull();
  });

  it('returns a completed publication without generating it again', async () => {
    const service = new ReleaseNotePublicationService(
      {
        findStreamState: jest.fn().mockResolvedValue({}),
        preparePublication: jest.fn().mockImplementation(async (input) => ({
          ...publication(ReleaseNotePublicationStatus.Completed),
          stream_key: input.stream.key
        }))
      } as unknown as ReleaseNotePublicationDb,
      {
        getValidatedReleaseRun: jest.fn().mockResolvedValue(currentRun),
        getPreviousSuccessfulReleaseRun: jest.fn()
      } as unknown as ReleaseNoteGitHubService
    );

    await expect(
      service.prepare(request, 'publication-id', {})
    ).resolves.toEqual(expect.objectContaining({ completed: true }));
  });
});
