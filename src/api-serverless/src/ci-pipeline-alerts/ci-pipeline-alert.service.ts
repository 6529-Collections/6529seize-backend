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
import { isReleaseBusGitHubAppActor } from '@/releaseBus/release-bus.constants';
import {
  releaseNoteGenerationQueue,
  ReleaseNoteGenerationQueue
} from '@/release-notes/release-note-generation-queue';
import { GITHUB_TO_6529_HANDLES } from '@/release-notes/release-note-contributors.config';
import { isAllowedReleaseNotesPrompt } from '@/release-notes/release-note-prompts.config';

export type CiPipelineAlertStatus = 'success' | 'failure';

export interface CiPipelineReleaseNoteGroup {
  readonly release_group_id: string;
  readonly release_group_services: string[];
  readonly pull_request_number: number;
  readonly publish_release_note: boolean;
}

export interface CiPipelineAlertRequest {
  readonly repo: string;
  readonly workflow: string;
  readonly status: CiPipelineAlertStatus;
  readonly title: string;
  readonly description?: string | null;
  readonly triggered_by_github_login?: string | null;
  readonly run_id: string;
  readonly run_number?: string | null;
  readonly run_url: string;
  readonly sha?: string | null;
  readonly branch?: string | null;
  readonly environment?: string | null;
  readonly service?: string | null;
  readonly release_notes_prompt_path?: string | null;
  readonly release_group_id?: string | null;
  readonly release_group_services?: string[];
  readonly pull_request_number?: number | null;
  readonly publish_release_note?: boolean;
  readonly release_note_groups?: CiPipelineReleaseNoteGroup[];
  readonly deployed_at?: string | null;
}

interface NormalizedReleaseNoteGroup {
  readonly releaseGroupId: string;
  readonly releaseGroupServices: string[];
  readonly pullRequestNumber: number | null;
  readonly publishReleaseNote: boolean;
}

interface MentionedProfile {
  readonly profileId: string;
  readonly handle: string;
}

interface AlertMentions {
  readonly triggeredBy: MentionedProfile | null;
  readonly failureCc: MentionedProfile[];
  readonly all: MentionedProfile[];
}

const MAX_DROP_CONTENT_LENGTH = 30000;
const MAX_DROP_TITLE_LENGTH = 250;
const MAX_ALERT_DESCRIPTION_LENGTH = 5000;

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const requestedEnd = maxLength - 3;
  const sliceEnd = /[\uD800-\uDBFF]/.test(value.charAt(requestedEnd - 1))
    ? requestedEnd - 1
    : requestedEnd;
  return `${value.slice(0, sliceEnd)}...`;
}

function normalizeOptionalValue(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function compareInvariant(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requestedReleaseNoteGroups(
  request: CiPipelineAlertRequest
): CiPipelineReleaseNoteGroup[] {
  return (
    request.release_note_groups ?? [
      {
        release_group_id:
          normalizeOptionalValue(request.release_group_id) ?? '',
        release_group_services: request.release_group_services ?? [],
        pull_request_number: request.pull_request_number ?? 0,
        publish_release_note: request.publish_release_note ?? false
      }
    ]
  );
}

function normalizeReleaseNoteGroup(
  group: CiPipelineReleaseNoteGroup,
  service: string | null | undefined,
  requiresPullRequest: boolean
): NormalizedReleaseNoteGroup | null {
  const releaseGroupId = normalizeOptionalValue(group.release_group_id);
  const releaseGroupServices = Array.from(
    new Set(
      group.release_group_services
        .map((groupService) => groupService.trim())
        .filter(Boolean)
    )
  ).sort(compareInvariant);
  const pullRequestNumber = group.pull_request_number || null;
  if (
    !releaseGroupId ||
    !releaseGroupServices.length ||
    (service && !releaseGroupServices.includes(service)) ||
    (requiresPullRequest && pullRequestNumber === null)
  ) {
    return null;
  }
  return {
    releaseGroupId,
    releaseGroupServices,
    pullRequestNumber,
    publishReleaseNote: group.publish_release_note
  };
}

export function parseProfileHandles(value: string | null): string[] {
  if (!value) {
    return [];
  }
  const seenNormalizedHandles = new Set<string>();
  return value
    .split(',')
    .map((handle) => normalizeConfiguredHandle(handle))
    .filter((handle) => {
      const normalizedHandle = handle.toLowerCase();
      if (!handle || seenNormalizedHandles.has(normalizedHandle)) {
        return false;
      }
      seenNormalizedHandles.add(normalizedHandle);
      return true;
    });
}

export function normalizeConfiguredHandle(value: string): string {
  const trimmed = value.trim();
  const bracketMention = /^@\[([^\]]+)\]$/.exec(trimmed);
  if (bracketMention) {
    return bracketMention[1].trim();
  }
  return trimmed.startsWith('@') ? trimmed.slice(1).trim() : trimmed;
}

export function normalizeTargetEnvironment(value: string | null | undefined) {
  const normalizedValue = normalizeOptionalValue(value)?.toLowerCase();
  if (normalizedValue === 'staging') {
    return 'staging';
  }
  if (normalizedValue === 'prod' || normalizedValue === 'production') {
    return 'prod';
  }
  return null;
}

function formatStatusEmoji(status: CiPipelineAlertStatus): string {
  return status === 'success' ? '✅' : '🚨';
}

function sanitizeAlertText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/[[\]<>]/g, (character) => `\\${character}`)
    .trim();
}

function formatAlertHeading(request: CiPipelineAlertRequest): string {
  const environmentPrefix = formatEnvironmentPrefix(request.environment);
  const statusEmoji = formatStatusEmoji(request.status);
  const statusSuffix = ` ${statusEmoji}`;
  const title = sanitizeAlertText(
    normalizeOptionalValue(request.title) ?? request.workflow
  )
    .replace(/✅|❌|🚨/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const truncatedTitle = truncate(
    title,
    MAX_DROP_TITLE_LENGTH - environmentPrefix.length - statusSuffix.length
  );
  return `${environmentPrefix}${truncatedTitle}${statusSuffix}`;
}

function formatEnvironmentPrefix(value: string | null | undefined): string {
  const environmentLabel = formatEnvironmentLabel(value);
  const stagingEmoji =
    normalizeTargetEnvironment(value) === 'staging' ? ' 🚧' : '';
  return `[${environmentLabel}${stagingEmoji}] `;
}

function formatEnvironmentLabel(value: string | null | undefined): string {
  const targetEnvironment = normalizeTargetEnvironment(value);
  return (
    targetEnvironment ??
    normalizeOptionalValue(value) ??
    'ci'
  ).toUpperCase();
}

function formatRepoLabel(repo: string): string {
  const repoName = repo.split('/').pop() ?? repo;
  if (repoName === '6529seize-backend') {
    return 'Backend';
  }
  if (repoName === '6529seize-frontend') {
    return 'Frontend';
  }
  if (repoName === '6529-core') {
    return 'Core';
  }
  return repoName;
}

function formatServiceLabel(request: CiPipelineAlertRequest): string {
  const repoLabel = formatRepoLabel(request.repo);
  const service = normalizeOptionalValue(request.service);
  if (repoLabel === 'Core' && service?.toLowerCase() === 'desktop') {
    return '6529 Desktop';
  }
  return service ? `${repoLabel} - ${service}` : repoLabel;
}

function formatInitiator(
  request: CiPipelineAlertRequest,
  mentions: AlertMentions
): string {
  if (isReleaseBusGitHubAppActor(request.triggered_by_github_login)) {
    return 'Release Train';
  }
  return mentions.triggeredBy
    ? '@[' + mentions.triggeredBy.handle + ']'
    : 'unknown';
}

function getGithubRepoUrl(request: CiPipelineAlertRequest): string | null {
  try {
    const runUrl = new URL(request.run_url);
    const [owner, repo] = runUrl.pathname.split('/').filter(Boolean);
    if (!owner || !repo) {
      return null;
    }
    return `${runUrl.origin}/${owner}/${repo}`;
  } catch {
    return null;
  }
}

function replaceAllLiteral(
  value: string,
  searchValue: string,
  replaceValue: string
): string {
  return (
    value as string & {
      replaceAll(searchValue: string, replaceValue: string): string;
    }
  ).replaceAll(searchValue, replaceValue);
}

export function formatMarkdownLink(label: string, url: string): string {
  const escapedLabel = replaceAllLiteral(
    replaceAllLiteral(label, '[', String.raw`\[`),
    ']',
    String.raw`\]`
  );
  return `[${escapedLabel}](${url})`;
}

function formatCommit(request: CiPipelineAlertRequest): string | null {
  const sha = normalizeOptionalValue(request.sha);
  if (!sha) {
    return null;
  }
  const shortSha = sha.slice(0, 8);
  const repoUrl = getGithubRepoUrl(request);
  return repoUrl
    ? formatMarkdownLink(shortSha, `${repoUrl}/commit/${sha}`)
    : shortSha;
}

function formatRun(request: CiPipelineAlertRequest): string {
  const runLabel = normalizeOptionalValue(request.run_number)
    ? `#${normalizeOptionalValue(request.run_number)}`
    : `#${request.run_id}`;
  return formatMarkdownLink(runLabel, request.run_url);
}

export class CiPipelineAlertService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly dropCreationApiService: DropCreationApiService,
    private readonly identitiesRepository: IdentitiesDb,
    private readonly releaseNotesQueue: ReleaseNoteGenerationQueue = releaseNoteGenerationQueue
  ) {}

  public async postAlert(
    request: CiPipelineAlertRequest,
    ctx: RequestContext
  ): Promise<void> {
    const waveId = this.resolveWaveId(request);
    const botProfileId = env.getStringOrThrow('CI_PIPELINES_BOT_PROFILE_ID');
    const mentions = await this.resolveAlertMentions(request);

    const createDropRequest = this.buildCreateDropRequest({
      request,
      waveId,
      mentions
    });
    const authenticationContext =
      AuthenticationContext.fromProfileId(botProfileId);

    await this.dropCreationApiService.createDrop(
      {
        createDropRequest,
        authorId: botProfileId,
        representativeId: botProfileId,
        hideLinkPreview: true
      },
      {
        ...ctx,
        authenticationContext
      }
    );

    await this.enqueueReleaseNotesIfEligible(request);
  }

  private async enqueueReleaseNotesIfEligible(
    request: CiPipelineAlertRequest
  ): Promise<void> {
    const promptPath = normalizeOptionalValue(
      request.release_notes_prompt_path
    );
    const sha = normalizeOptionalValue(request.sha);
    const deployedAt = normalizeOptionalValue(request.deployed_at);
    const isBackendRelease =
      request.repo.split('/').pop() === '6529seize-backend';
    if (
      request.status !== 'success' ||
      normalizeTargetEnvironment(request.environment) !== 'prod' ||
      !promptPath ||
      !sha ||
      !deployedAt
    ) {
      return;
    }
    if (!isAllowedReleaseNotesPrompt(request.repo, promptPath)) {
      this.logger.warn(
        `Skipping release notes for unsupported prompt path ${promptPath} in ${request.repo}`
      );
      return;
    }

    const structuredGroups = request.release_note_groups !== undefined;
    for (const group of requestedReleaseNoteGroups(request)) {
      const normalizedGroup = normalizeReleaseNoteGroup(
        group,
        request.service,
        isBackendRelease
      );
      if (!normalizedGroup) {
        if (structuredGroups) {
          throw new Error(
            `Malformed structured release-note group ${group.release_group_id || 'missing'} for ${request.repo} run ${request.run_id}`
          );
        }
        this.logger.warn(
          `Skipping malformed release-note group ${group.release_group_id || 'missing'} for ${request.repo} run ${request.run_id}`
        );
        continue;
      }
      await this.releaseNotesQueue.enqueueBestEffort({
        repo: request.repo,
        workflow: request.workflow,
        run_id: request.run_id,
        run_number: request.run_number,
        run_url: request.run_url,
        sha,
        branch: request.branch,
        environment: 'prod',
        service: request.service,
        prompt_path: promptPath,
        release_group_id: normalizedGroup.releaseGroupId,
        release_group_services: normalizedGroup.releaseGroupServices,
        pull_request_number: normalizedGroup.pullRequestNumber,
        publish_release_note: normalizedGroup.publishReleaseNote,
        deployed_at: deployedAt
      });
    }
  }

  private async resolveAlertMentions(
    request: CiPipelineAlertRequest
  ): Promise<AlertMentions> {
    const triggeredByGithubLogin = normalizeOptionalValue(
      request.triggered_by_github_login
    );
    const isReleaseTrain = isReleaseBusGitHubAppActor(triggeredByGithubLogin);
    const triggeredByHandle =
      triggeredByGithubLogin && !isReleaseTrain
        ? GITHUB_TO_6529_HANDLES[triggeredByGithubLogin.toLowerCase()]
        : null;
    if (!triggeredByGithubLogin) {
      this.logger.warn(
        'Unable to resolve CI workflow initiator: GitHub login is missing'
      );
    } else if (!isReleaseTrain && !triggeredByHandle) {
      this.logger.warn(
        `Unable to resolve CI workflow initiator ${triggeredByGithubLogin}: 6529 profile mapping is missing`
      );
    }

    const failureHandles =
      request.status === 'failure'
        ? parseProfileHandles(
            env.getStringOrNull('CI_PIPELINES_FAILURE_MENTION_PROFILE_HANDLES')
          )
        : [];
    const handlesToResolve = [
      ...(triggeredByHandle ? [triggeredByHandle] : []),
      ...failureHandles
    ].filter(
      (handle, index, handles) =>
        handles.findIndex(
          (candidate) => candidate.toLowerCase() === handle.toLowerCase()
        ) === index
    );
    if (!handlesToResolve.length) {
      return { triggeredBy: null, failureCc: [], all: [] };
    }

    const profileIdsByHandle =
      await this.identitiesRepository.getIdsByHandles(handlesToResolve);
    const mentionsByNormalizedHandle = new Map(
      Object.entries(profileIdsByHandle).map(([handle, profileId]) => [
        handle.toLowerCase(),
        {
          profileId,
          handle
        }
      ])
    );
    const triggeredBy = triggeredByHandle
      ? (mentionsByNormalizedHandle.get(triggeredByHandle.toLowerCase()) ??
        null)
      : null;
    if (triggeredByHandle && !triggeredBy) {
      this.logger.warn(
        `Unable to resolve CI workflow initiator ${triggeredByGithubLogin}: 6529 profile ${triggeredByHandle} is missing`
      );
    }

    const missingHandles = failureHandles.filter(
      (handle) => !mentionsByNormalizedHandle.has(handle.toLowerCase())
    );
    if (missingHandles.length) {
      this.logger.warn(
        `Skipping CI pipeline alert mentions with missing profiles: ${missingHandles.join(', ')}`
      );
    }
    const failureCc = failureHandles
      .map((handle) => mentionsByNormalizedHandle.get(handle.toLowerCase()))
      .filter((mention): mention is MentionedProfile => !!mention);
    // Profile IDs collapse handle aliases while preserving initiator-first order.
    const all = [...(triggeredBy ? [triggeredBy] : []), ...failureCc].filter(
      (mention, index, mentions) =>
        mentions.findIndex(
          (candidate) => candidate.profileId === mention.profileId
        ) === index
    );

    return { triggeredBy, failureCc, all };
  }

  private resolveWaveId(request: CiPipelineAlertRequest): string {
    const targetEnvironment = normalizeTargetEnvironment(request.environment);
    if (targetEnvironment === 'staging') {
      return env.getStringOrThrow('CI_PIPELINES_STAGING_WAVE_ID');
    }
    if (targetEnvironment === 'prod') {
      return env.getStringOrThrow('CI_PIPELINES_PROD_WAVE_ID');
    }
    throw new Error(
      `Unsupported CI pipeline alert environment: ${request.environment ?? 'missing'}`
    );
  }

  private buildCreateDropRequest({
    request,
    waveId,
    mentions
  }: {
    readonly request: CiPipelineAlertRequest;
    readonly waveId: string;
    readonly mentions: AlertMentions;
  }): ApiCreateDropRequest {
    const content = this.formatContent(request, mentions);
    return {
      title: null,
      drop_type: ApiDropType.Chat,
      parts: [
        {
          content,
          quoted_drop: null,
          media: []
        }
      ],
      mentioned_users: mentions.all.map((mention) => ({
        mentioned_profile_id: mention.profileId,
        handle_in_content: mention.handle
      })),
      mentioned_groups: [],
      referenced_nfts: [],
      metadata: [],
      signature: null,
      is_safe_signature: false,
      wave_id: waveId
    };
  }

  private formatContent(
    request: CiPipelineAlertRequest,
    mentions: AlertMentions
  ): string {
    const failureMentionHandles = mentions.failureCc
      .map((mention) => '@[' + mention.handle + ']')
      .join(' ');
    const failureMentionLines = failureMentionHandles
      ? ['', `cc ${failureMentionHandles}`]
      : [];

    const branch = normalizeOptionalValue(request.branch);
    const commit = formatCommit(request);
    const description = normalizeOptionalValue(request.description);
    const formattedDescription = description
      ? truncate(sanitizeAlertText(description), MAX_ALERT_DESCRIPTION_LENGTH)
      : null;
    const triggeredBy = formatInitiator(request, mentions);
    const lines = [
      formatAlertHeading(request),
      '',
      ...(formattedDescription ? [formattedDescription, ''] : []),
      `Service: ${formatServiceLabel(request)}`,
      `Workflow: ${request.workflow}`,
      ...(branch ? [`Branch: ${branch}`] : []),
      ...(commit ? [`Commit: ${commit}`] : []),
      `Initiated by: ${triggeredBy}`,
      `Run: ${formatRun(request)}`,
      ...failureMentionLines
    ];

    return truncate(lines.join('\n'), MAX_DROP_CONTENT_LENGTH);
  }
}

export const ciPipelineAlertService = new CiPipelineAlertService(
  dropCreationService,
  identitiesDb,
  releaseNoteGenerationQueue
);
