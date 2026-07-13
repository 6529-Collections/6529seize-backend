import { AiPrompter } from '@/abusiveness/ai-prompter';
import { AuthenticationContext } from '@/auth-context';
import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import {
  DropCreationApiService,
  dropCreationService
} from '@/api/drops/drop-creation.api.service';
import { env } from '@/env';
import { identitiesDb, IdentitiesDb } from '@/identities/identities.db';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { dropsDb, DropsDb } from '@/drops/drops.db';
import { createHash } from 'node:crypto';
import { GITHUB_TO_6529_HANDLES } from './release-note-contributors.config';
import { releaseNotesBedrockPrompter } from './release-notes-bedrock.prompter';
import {
  GitHubReleaseContext,
  releaseNoteGitHubService,
  ReleaseNoteGitHubService,
  ReleasePullRequestContext
} from './release-note-github.service';
import { ReleaseNoteGenerationRequest } from './release-note-generation-queue';

interface GeneratedReleaseNote {
  readonly number: number;
  readonly summary: string;
}

interface MentionedProfile {
  readonly profileId: string;
  readonly handle: string;
}

interface ContributorResolution {
  readonly mentionsByGithubLogin: Map<string, MentionedProfile>;
  readonly mentionedProfiles: MentionedProfile[];
}

const MAX_BODY_LENGTH = 12000;
const MAX_COMMIT_MESSAGES = 25;
const MAX_COMMIT_MESSAGE_LENGTH = 500;
const MAX_CHANGED_FILES = 300;
const MAX_SUMMARY_LENGTH = 600;
const MAX_RELEASE_CONTEXT_LENGTH = 200000;
const RELEASE_NOTE_ID_METADATA_KEY = 'release_note_id';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSummary(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const summary = value
    .replace(/\s+/g, ' ')
    .replace(/@\[/g, '@(')
    .replace(/[[\]`*_~]/g, '')
    .trim();
  return summary ? summary.slice(0, MAX_SUMMARY_LENGTH) : null;
}

function parseJsonReply(reply: string): unknown {
  const trimmed = reply.trim();
  if (!trimmed.startsWith('```')) {
    return JSON.parse(trimmed);
  }
  const contentStart = trimmed.indexOf('\n');
  if (contentStart < 0 || !trimmed.endsWith('```')) {
    throw new TypeError('Invalid fenced release notes response');
  }
  return JSON.parse(trimmed.slice(contentStart + 1, -3).trim());
}

function formatMarkdownLink(label: string, url: string): string {
  const escapedLabel = label.replace(/[[\]]/g, (character) => `\\${character}`);
  return `[${escapedLabel}](${url})`;
}

function getRepoName(repo: string): string {
  return repo.split('/').pop() ?? repo;
}

function buildReleaseNotePublicationId(
  request: ReleaseNoteGenerationRequest
): string {
  return createHash('sha256')
    .update(request.repo)
    .update('\0')
    .update(request.release_group_id)
    .update('\0')
    .update(request.sha)
    .digest('hex');
}

function getReleaseHeading(request: ReleaseNoteGenerationRequest): string {
  const repository = request.repo.includes('/')
    ? request.repo
    : `6529-Collections/${request.repo}`;
  const surface =
    getRepoName(request.repo) === '6529seize-frontend' ? 'Frontend' : 'Backend';
  const shortSha = request.sha.slice(0, 8);
  const commit = formatMarkdownLink(
    shortSha,
    `https://github.com/${repository}/commit/${request.sha}`
  );
  const deployedAt = new Date(request.deployed_at);
  if (Number.isNaN(deployedAt.getTime())) {
    throw new TypeError(`Invalid release deployed_at ${request.deployed_at}`);
  }
  const formattedDate = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short'
  }).format(deployedAt);
  return `${surface} deploy · commit ${commit} — ${formattedDate}`;
}

function sanitizeContext(context: GitHubReleaseContext) {
  return {
    previous_sha: context.previous_sha,
    current_sha: context.current_sha,
    pull_requests: context.pull_requests.map((pullRequest) => ({
      ...pullRequest,
      body: pullRequest.body?.slice(0, MAX_BODY_LENGTH) ?? null,
      commit_messages: pullRequest.commit_messages
        .slice(0, MAX_COMMIT_MESSAGES)
        .map((message) => message.slice(0, MAX_COMMIT_MESSAGE_LENGTH)),
      changed_files: pullRequest.changed_files.slice(0, MAX_CHANGED_FILES)
    }))
  };
}

export class ReleaseNoteGenerationService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly githubService: ReleaseNoteGitHubService,
    private readonly aiPrompter: AiPrompter,
    private readonly dropCreationApiService: DropCreationApiService,
    private readonly identitiesRepository: IdentitiesDb,
    private readonly contributorsConfig: Readonly<
      Record<string, string>
    > = GITHUB_TO_6529_HANDLES,
    private readonly dropsRepository: DropsDb = dropsDb
  ) {}

  public async generateAndPost(
    request: ReleaseNoteGenerationRequest,
    ctx: RequestContext
  ): Promise<void> {
    const botProfileId = env.getStringOrThrow('CI_PIPELINES_BOT_PROFILE_ID');
    const waveId = env.getStringOrThrow('CI_RELEASES_WAVE_ID');
    const publicationId = buildReleaseNotePublicationId(request);
    const existingDropId = await this.dropsRepository.findDropIdByMetadata(
      {
        waveId,
        dataKey: RELEASE_NOTE_ID_METADATA_KEY,
        dataValue: publicationId
      },
      ctx
    );
    if (existingDropId) {
      this.logger.info(
        `Skipping release note ${publicationId}; drop ${existingDropId} already exists`
      );
      return;
    }
    const context = await this.githubService.getReleaseContext(request);
    if (!context) {
      this.logger.info(
        `Skipping release notes for ${request.repo} run ${request.run_id}; no previous successful production run was found`
      );
      return;
    }
    if (!context.pull_requests.length) {
      this.logger.info(
        `Skipping release notes for ${request.repo} run ${request.run_id}; no merged pull requests were found`
      );
      return;
    }
    const repositoryPrompt = await this.githubService.getReleasePrompt(request);

    const reply = await this.aiPrompter.promptAndGetReply(
      this.buildPrompt(repositoryPrompt, context)
    );
    const generatedNotes = this.parseGeneratedNotes(reply, context);
    const contributors = await this.resolveContributors(context.pull_requests);
    const createDropRequest = this.buildCreateDropRequest({
      request,
      context,
      generatedNotes,
      contributors,
      publicationId,
      waveId
    });

    await this.dropCreationApiService.createDrop(
      {
        createDropRequest,
        authorId: botProfileId,
        representativeId: botProfileId,
        hideLinkPreview: true
      },
      {
        ...ctx,
        authenticationContext: AuthenticationContext.fromProfileId(botProfileId)
      }
    );
  }

  private buildPrompt(
    repositoryPrompt: string,
    context: GitHubReleaseContext
  ): string {
    const serializedContext = JSON.stringify(sanitizeContext(context));
    if (serializedContext.length > MAX_RELEASE_CONTEXT_LENGTH) {
      throw new Error(
        `Release context exceeds maximum of ${MAX_RELEASE_CONTEXT_LENGTH} characters`
      );
    }
    return [
      repositoryPrompt.trim(),
      '',
      'Release metadata follows between <release_context> tags.',
      '<release_context>',
      serializedContext,
      '</release_context>'
    ].join('\n');
  }

  private parseGeneratedNotes(
    reply: string,
    context: GitHubReleaseContext
  ): GeneratedReleaseNote[] {
    const parsed = parseJsonReply(reply);
    if (!isRecord(parsed) || !Array.isArray(parsed.pull_requests)) {
      throw new Error('Release notes response is missing pull_requests');
    }

    const contextsByNumber = new Map(
      context.pull_requests.map((pullRequest) => [
        pullRequest.number,
        pullRequest
      ])
    );
    const seenNumbers = new Set<number>();
    const generatedNotes = parsed.pull_requests.map((value) => {
      if (!isRecord(value) || typeof value.number !== 'number') {
        throw new Error('Release notes response contains an invalid PR number');
      }
      const pullRequest = contextsByNumber.get(value.number);
      if (!pullRequest || seenNumbers.has(value.number)) {
        throw new Error(
          `Release notes response contains unexpected or duplicate PR ${value.number}`
        );
      }
      seenNumbers.add(value.number);

      const summary = normalizeSummary(value.summary);
      if (!summary) {
        throw new Error(
          `Release notes response contains an empty summary for PR ${value.number}`
        );
      }
      return {
        number: value.number,
        summary
      };
    });

    if (seenNumbers.size !== contextsByNumber.size) {
      throw new Error(
        'Release notes response did not include every pull request'
      );
    }
    return generatedNotes.sort((a, b) => a.number - b.number);
  }

  private async resolveContributors(
    pullRequests: ReleasePullRequestContext[]
  ): Promise<ContributorResolution> {
    const mappedHandlesByGithubLogin = new Map<string, string>();
    for (const login of pullRequests.flatMap(
      (pullRequest) => pullRequest.contributors
    )) {
      const normalizedLogin = login.toLowerCase();
      const handle = this.contributorsConfig[normalizedLogin]?.trim();
      if (handle) {
        mappedHandlesByGithubLogin.set(normalizedLogin, handle);
      }
    }

    const handles = Array.from(
      new Set(Array.from(mappedHandlesByGithubLogin.values()))
    );
    if (!handles.length) {
      return {
        mentionsByGithubLogin: new Map(),
        mentionedProfiles: []
      };
    }

    const profileIdsByHandle =
      await this.identitiesRepository.getIdsByHandles(handles);
    const profilesByNormalizedHandle = new Map(
      Object.entries(profileIdsByHandle).map(([handle, profileId]) => [
        handle.toLowerCase(),
        { handle, profileId }
      ])
    );
    const mentionsByGithubLogin = new Map<string, MentionedProfile>();
    mappedHandlesByGithubLogin.forEach((handle, login) => {
      const profile = profilesByNormalizedHandle.get(handle.toLowerCase());
      if (profile) {
        mentionsByGithubLogin.set(login, profile);
      } else {
        this.logger.warn(
          `Skipping release note mention for GitHub user ${login}; 6529 handle ${handle} was not found`
        );
      }
    });

    const mentionedProfilesById = new Map<string, MentionedProfile>();
    Array.from(mentionsByGithubLogin.values()).forEach((profile) => {
      mentionedProfilesById.set(profile.profileId, profile);
    });
    const mentionedProfiles = Array.from(mentionedProfilesById.values());
    return { mentionsByGithubLogin, mentionedProfiles };
  }

  private buildCreateDropRequest({
    request,
    context,
    generatedNotes,
    contributors,
    publicationId,
    waveId
  }: {
    readonly request: ReleaseNoteGenerationRequest;
    readonly context: GitHubReleaseContext;
    readonly generatedNotes: GeneratedReleaseNote[];
    readonly contributors: ContributorResolution;
    readonly publicationId: string;
    readonly waveId: string;
  }): ApiCreateDropRequest {
    const contextsByNumber = new Map(
      context.pull_requests.map((pullRequest) => [
        pullRequest.number,
        pullRequest
      ])
    );
    const lines = generatedNotes.map((note) => {
      const pullRequest = contextsByNumber.get(note.number);
      if (!pullRequest) {
        throw new Error(`Missing release context for PR ${note.number}`);
      }
      const credits = this.formatContributors(
        pullRequest.contributors,
        contributors.mentionsByGithubLogin
      );
      const pullRequestLink = formatMarkdownLink(
        `PR #${note.number}`,
        pullRequest.url
      );
      const contributorSuffix = credits ? ` - ${credits}` : '';
      return `- ${pullRequestLink}: ${note.summary}${contributorSuffix}`;
    });
    const isBackend = getRepoName(request.repo) === '6529seize-backend';
    const serviceLines =
      isBackend && request.release_group_services.length
        ? [
            '',
            `Services affected: ${request.release_group_services.join(', ')}`
          ]
        : [];
    const content = [
      getReleaseHeading(request),
      '',
      ...lines,
      ...serviceLines
    ].join('\n');

    return {
      title: null,
      drop_type: ApiDropType.Chat,
      parts: [{ content, quoted_drop: null, media: [] }],
      mentioned_users: contributors.mentionedProfiles.map((profile) => ({
        mentioned_profile_id: profile.profileId,
        handle_in_content: profile.handle
      })),
      mentioned_groups: [],
      referenced_nfts: [],
      metadata: [
        {
          data_key: RELEASE_NOTE_ID_METADATA_KEY,
          data_value: publicationId
        }
      ],
      signature: null,
      is_safe_signature: false,
      wave_id: waveId
    };
  }

  private formatContributors(
    githubLogins: string[],
    mentionsByGithubLogin: Map<string, MentionedProfile>
  ): string {
    return githubLogins
      .map((login) => {
        const mention = mentionsByGithubLogin.get(login.toLowerCase());
        return mention
          ? `@[${mention.handle}]`
          : formatMarkdownLink(`@${login}`, `https://github.com/${login}`);
      })
      .join(', ');
  }
}

export const releaseNoteGenerationService = new ReleaseNoteGenerationService(
  releaseNoteGitHubService,
  releaseNotesBedrockPrompter,
  dropCreationService,
  identitiesDb
);
