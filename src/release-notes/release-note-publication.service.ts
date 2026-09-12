import { createHash } from 'node:crypto';
import { ReleaseNotePublicationStatus } from '@/entities/IReleaseNotePublication';
import { RequestContext } from '@/request.context';
import { ReleaseNoteGenerationRequest } from './release-note-generation-queue';
import {
  GitHubReleaseRun,
  releaseNoteGitHubService,
  ReleaseNoteGitHubService
} from './release-note-github.service';
import {
  releaseNotePublicationDb,
  ReleaseNotePublicationDb,
  ReleaseNotePublicationRun,
  ReleaseNotePublicationStream
} from './release-note-publication.db';

export interface PreparedReleaseNotePublication {
  readonly publicationId: string;
  readonly previousSha: string;
  readonly completed: boolean;
}

function normalizeRepository(repo: string): string {
  return repo.includes('/') ? repo : `6529-Collections/${repo}`;
}

function normalizeBranch(branch: string | null | undefined): string {
  return branch?.trim() || 'main';
}

function getRepoName(repo: string): string {
  return repo.split('/').pop() ?? repo;
}

function toPublicationRun(run: GitHubReleaseRun): ReleaseNotePublicationRun {
  return { id: run.id, number: run.run_number, sha: run.sha };
}

function buildStream(
  request: ReleaseNoteGenerationRequest,
  run: GitHubReleaseRun
): ReleaseNotePublicationStream {
  const repository = normalizeRepository(request.repo);
  const branch =
    getRepoName(request.repo) === '6529-core'
      ? 'production-release-branches'
      : normalizeBranch(request.branch);
  const environment = request.environment.trim().toLowerCase();
  const key = createHash('sha256')
    .update(repository)
    .update('\0')
    .update(run.workflow_id)
    .update('\0')
    .update(branch)
    .update('\0')
    .update(environment)
    .digest('hex');
  return {
    key,
    repository,
    workflowId: run.workflow_id,
    branch,
    environment
  };
}

export class ReleaseNotePublicationService {
  public constructor(
    private readonly publicationDb: ReleaseNotePublicationDb,
    private readonly githubService: ReleaseNoteGitHubService
  ) {}

  public async prepare(
    request: ReleaseNoteGenerationRequest,
    publicationId: string,
    ctx: RequestContext
  ): Promise<PreparedReleaseNotePublication | null> {
    const currentRun = await this.githubService.getValidatedReleaseRun(request);
    const stream = buildStream(request, currentRun);
    const existingStream = await this.publicationDb.findStreamState(
      stream.key,
      ctx
    );
    const bootstrapPreviousRun = existingStream
      ? null
      : await this.githubService.getPreviousSuccessfulReleaseRun(
          request,
          currentRun
        );
    const publication = await this.publicationDb.preparePublication(
      {
        publicationId,
        stream,
        currentRun: toPublicationRun(currentRun),
        bootstrapPreviousRun: bootstrapPreviousRun
          ? toPublicationRun(bootstrapPreviousRun)
          : null
      },
      ctx
    );
    if (!publication) {
      return null;
    }
    if (
      publication.current_run_id !== currentRun.id ||
      publication.current_run_number !== currentRun.run_number ||
      publication.current_sha !== currentRun.sha ||
      publication.stream_key !== stream.key
    ) {
      throw new Error(
        `Release-note publication ${publicationId} does not match the validated run`
      );
    }
    return {
      publicationId,
      previousSha: publication.previous_sha,
      completed:
        publication.status === ReleaseNotePublicationStatus.Completed ||
        publication.status === ReleaseNotePublicationStatus.Superseded
    };
  }

  public async recordPlan(
    publicationId: string,
    totalParts: number,
    ctx: RequestContext
  ): Promise<void> {
    await this.publicationDb.recordPlan(publicationId, totalParts, ctx);
  }

  public async recordPart(
    input: {
      readonly publicationId: string;
      readonly partNumber: number;
      readonly totalParts: number;
      readonly dropId: string;
    },
    ctx: RequestContext
  ): Promise<void> {
    await this.publicationDb.recordPart(input, ctx);
  }

  public async complete(
    publicationId: string,
    ctx: RequestContext
  ): Promise<void> {
    await this.publicationDb.completePublication(publicationId, ctx);
  }
}

export const releaseNotePublicationService = new ReleaseNotePublicationService(
  releaseNotePublicationDb,
  releaseNoteGitHubService
);
