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

export type CiPipelineAlertStatus = 'success' | 'failure';

export interface CiPipelineAlertRequest {
  readonly repo: string;
  readonly workflow: string;
  readonly status: CiPipelineAlertStatus;
  readonly title: string;
  readonly description?: string | null;
  readonly run_id: string;
  readonly run_number?: string | null;
  readonly run_url: string;
  readonly sha?: string | null;
  readonly branch?: string | null;
  readonly environment?: string | null;
  readonly service?: string | null;
}

interface MentionedProfile {
  readonly profileId: string;
  readonly handle: string;
}

const MAX_DROP_CONTENT_LENGTH = 30000;
const MAX_DROP_TITLE_LENGTH = 250;

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

function normalizeOptionalValue(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function parseProfileHandles(value: string | null): string[] {
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

function normalizeConfiguredHandle(value: string): string {
  const trimmed = value.trim();
  const bracketMention = /^@\[([^\]]+)\]$/.exec(trimmed);
  if (bracketMention) {
    return bracketMention[1].trim();
  }
  return trimmed.startsWith('@') ? trimmed.slice(1).trim() : trimmed;
}

function normalizeTargetEnvironment(value: string | null | undefined) {
  const normalizedValue = normalizeOptionalValue(value)?.toLowerCase();
  if (normalizedValue === 'staging') {
    return 'staging';
  }
  if (normalizedValue === 'prod' || normalizedValue === 'production') {
    return 'prod';
  }
  return null;
}

function formatStatusVerb(status: CiPipelineAlertStatus): string {
  return status === 'success' ? 'Succeeded' : 'Failed';
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
  return service ? `${repoLabel} - ${service}` : repoLabel;
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

function formatMarkdownLink(label: string, url: string): string {
  return `[${label.replace(/\[/g, '\\[').replace(/\]/g, '\\]')}](${url})`;
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
    private readonly identitiesRepository: IdentitiesDb
  ) {}

  public async postAlert(
    request: CiPipelineAlertRequest,
    ctx: RequestContext
  ): Promise<void> {
    const waveId = this.resolveWaveId(request);
    const botProfileId = env.getStringOrThrow('CI_PIPELINES_BOT_PROFILE_ID');
    const mentions =
      request.status === 'failure'
        ? await this.resolveFailureMentions(ctx)
        : [];

    const createDropRequest = this.buildCreateDropRequest({
      request,
      waveId,
      mentions
    });
    const authenticationContext =
      AuthenticationContext.fromProfileId(botProfileId);

    const createdDrop = await this.dropCreationApiService.createDrop(
      {
        createDropRequest,
        authorId: botProfileId,
        representativeId: botProfileId
      },
      {
        ...ctx,
        authenticationContext
      }
    );
    await this.dropCreationApiService.toggleHideLinkPreview(
      {
        dropId: createdDrop.id,
        hideLinkPreview: true
      },
      {
        ...ctx,
        authenticationContext
      }
    );
  }

  private async resolveFailureMentions(
    ctx: RequestContext
  ): Promise<MentionedProfile[]> {
    const configuredHandles = parseProfileHandles(
      env.getStringOrNull('CI_PIPELINES_FAILURE_MENTION_PROFILE_HANDLES')
    );
    if (!configuredHandles.length) {
      return [];
    }

    const profileIdsByHandle = await this.identitiesRepository.getIdsByHandles(
      configuredHandles,
      ctx.connection
    );
    const mentionsByNormalizedHandle = new Map(
      Object.entries(profileIdsByHandle).map(([handle, profileId]) => [
        handle.toLowerCase(),
        {
          profileId,
          handle
        }
      ])
    );
    const missingHandles = configuredHandles.filter(
      (handle) => !mentionsByNormalizedHandle.has(handle.toLowerCase())
    );
    if (missingHandles.length) {
      this.logger.warn(
        `Skipping CI pipeline alert mentions with missing profiles: ${missingHandles.join(', ')}`
      );
    }

    return configuredHandles
      .map((handle) => mentionsByNormalizedHandle.get(handle.toLowerCase()))
      .filter((mention): mention is MentionedProfile => !!mention);
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
    readonly mentions: MentionedProfile[];
  }): ApiCreateDropRequest {
    const content = this.formatContent(request, mentions);
    return {
      title: truncate(
        `[${formatEnvironmentLabel(request.environment)}] Deploy ${formatStatusVerb(request.status)}`,
        MAX_DROP_TITLE_LENGTH
      ),
      drop_type: ApiDropType.Chat,
      parts: [
        {
          content,
          quoted_drop: null,
          media: []
        }
      ],
      mentioned_users: mentions.map((mention) => ({
        mentioned_profile_id: mention.profileId,
        handle_in_content: mention.handle
      })),
      mentioned_groups: [],
      referenced_nfts: [],
      metadata: [
        { data_key: 'source', data_value: 'github-actions' },
        { data_key: 'repo', data_value: request.repo },
        { data_key: 'workflow', data_value: request.workflow },
        { data_key: 'run_id', data_value: request.run_id },
        { data_key: 'status', data_value: request.status }
      ],
      signature: null,
      is_safe_signature: false,
      wave_id: waveId
    };
  }

  private formatContent(
    request: CiPipelineAlertRequest,
    mentions: MentionedProfile[]
  ): string {
    const mentionHandles = mentions
      .map((mention) => '@[' + mention.handle + ']')
      .join(' ');
    const mentionLines = mentions.length ? [`cc ${mentionHandles}`, ''] : [];

    const branch = normalizeOptionalValue(request.branch);
    const commit = formatCommit(request);
    const lines = [
      ...mentionLines,
      `Service: ${formatServiceLabel(request)}`,
      `Workflow: ${request.workflow}`,
      ...(branch ? [`Branch: ${branch}`] : []),
      ...(commit ? [`Commit: ${commit}`] : []),
      `Run: ${formatRun(request)}`
    ];

    return truncate(lines.join('\n'), MAX_DROP_CONTENT_LENGTH);
  }
}

export const ciPipelineAlertService = new CiPipelineAlertService(
  dropCreationService,
  identitiesDb
);
