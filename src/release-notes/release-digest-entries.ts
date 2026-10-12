import { createHash } from 'node:crypto';
import type {
  NewReleaseDigestEntry,
  ReleaseDigestContributor
} from './release-digest.db';
import type { ReleaseNoteGenerationRequest } from './release-note-generation-queue';
import type { GitHubReleaseContext } from './release-note-github.service';

const MAX_DIGEST_TITLE_LENGTH = 500;
const MAX_DIGEST_URL_LENGTH = 500;
const MAX_DIGEST_BODY_LENGTH = 4000;

interface DigestContributorMention {
  readonly profileId: string;
  readonly handle: string;
}

export interface BuildReleaseDigestEntriesInput {
  readonly request: Pick<ReleaseNoteGenerationRequest, 'repo' | 'deployed_at'>;
  readonly context: Pick<GitHubReleaseContext, 'pull_requests'>;
  readonly generatedNotes: ReadonlyArray<{
    readonly number: number;
    readonly summary: string;
  }>;
  readonly contributors: {
    readonly mentionsByGithubLogin: ReadonlyMap<
      string,
      DigestContributorMention
    >;
  };
  readonly publicationId: string;
}

function toContributors(
  githubLogins: readonly string[],
  mentionsByGithubLogin: ReadonlyMap<string, DigestContributorMention>
): ReleaseDigestContributor[] {
  const seen = new Set<string>();
  return githubLogins.flatMap((login) => {
    const normalizedLogin = login.toLowerCase();
    if (seen.has(normalizedLogin)) {
      return [];
    }
    seen.add(normalizedLogin);
    const mention = mentionsByGithubLogin.get(normalizedLogin);
    return [
      {
        github_login: login,
        handle: mention?.handle ?? null,
        profile_id: mention?.profileId ?? null
      }
    ];
  });
}

/**
 * Converts the pull requests of one published deploy note into digest
 * entries. Ids are deterministic so regenerated notes update their entries.
 */
export function buildReleaseDigestEntries({
  request,
  context,
  generatedNotes,
  contributors,
  publicationId
}: BuildReleaseDigestEntriesInput): NewReleaseDigestEntry[] {
  const deployedAt = Date.parse(request.deployed_at);
  if (!Number.isFinite(deployedAt)) {
    throw new TypeError(
      `Release digest entries need a valid deployed_at, got ${request.deployed_at}`
    );
  }
  const pullRequestsByNumber = new Map(
    context.pull_requests.map((pullRequest) => [
      pullRequest.number,
      pullRequest
    ])
  );
  return generatedNotes.flatMap((note) => {
    const pullRequest = pullRequestsByNumber.get(note.number);
    if (!pullRequest) {
      return [];
    }
    return [
      {
        id: createHash('sha256')
          .update(publicationId)
          .update('\0')
          .update(request.repo)
          .update('\0')
          .update(String(pullRequest.number))
          .digest('hex'),
        repository: request.repo,
        pull_request_number: pullRequest.number,
        pull_request_title: pullRequest.title.slice(0, MAX_DIGEST_TITLE_LENGTH),
        pull_request_url: pullRequest.url.slice(0, MAX_DIGEST_URL_LENGTH),
        pull_request_body:
          pullRequest.body?.slice(0, MAX_DIGEST_BODY_LENGTH) ?? null,
        summary: note.summary,
        contributors: toContributors(
          pullRequest.contributors,
          contributors.mentionsByGithubLogin
        ),
        services: Array.from(new Set(pullRequest.candidate_services)).sort(
          (a, b) => a.localeCompare(b)
        ),
        publication_id: publicationId,
        deployed_at: deployedAt
      }
    ];
  });
}
