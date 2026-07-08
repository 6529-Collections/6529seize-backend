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

function parseProfileIds(value: string | null): string[] {
  if (!value) {
    return [];
  }
  const seen = new Set<string>();
  return value
    .split(',')
    .map((profileId) => profileId.trim())
    .filter((profileId) => {
      if (!profileId || seen.has(profileId)) {
        return false;
      }
      seen.add(profileId);
      return true;
    });
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
    const waveId = env.getStringOrThrow('CI_PIPELINES_WAVE_ID');
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

    await this.dropCreationApiService.createDrop(
      {
        createDropRequest,
        authorId: botProfileId,
        representativeId: botProfileId
      },
      {
        ...ctx,
        authenticationContext: AuthenticationContext.fromProfileId(botProfileId)
      }
    );
  }

  private async resolveFailureMentions(
    ctx: RequestContext
  ): Promise<MentionedProfile[]> {
    const profileIds = parseProfileIds(
      env.getStringOrNull('CI_PIPELINES_FAILURE_MENTION_PROFILE_IDS')
    );
    if (!profileIds.length) {
      return [];
    }

    const handlesByProfileId =
      await this.identitiesRepository.getProfileHandlesByIds(profileIds, ctx);
    const missingProfileIds = profileIds.filter(
      (profileId) => !handlesByProfileId[profileId]
    );
    if (missingProfileIds.length) {
      this.logger.warn(
        `Skipping CI pipeline alert mentions with missing handles: ${missingProfileIds.join(', ')}`
      );
    }

    return profileIds
      .map((profileId) => ({
        profileId,
        handle: handlesByProfileId[profileId]
      }))
      .filter((mention): mention is MentionedProfile => !!mention.handle);
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
        `CI ${request.status}: ${request.title}`,
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

    const description = normalizeOptionalValue(request.description);
    const environment = normalizeOptionalValue(request.environment);
    const service = normalizeOptionalValue(request.service);
    const branch = normalizeOptionalValue(request.branch);
    const sha = normalizeOptionalValue(request.sha);
    const lines = [
      `[${request.status.toUpperCase()}] ${request.title}`,
      '',
      ...mentionLines,
      ...(description ? [description, ''] : []),
      `Repo: ${request.repo}`,
      `Workflow: ${request.workflow}`,
      ...(environment ? [`Environment: ${environment}`] : []),
      ...(service ? [`Service: ${service}`] : []),
      ...(branch ? [`Branch: ${branch}`] : []),
      ...(sha ? [`Commit: ${sha}`] : []),
      `Run: ${request.run_url}`
    ];

    return truncate(lines.join('\n'), MAX_DROP_CONTENT_LENGTH);
  }
}

export const ciPipelineAlertService = new CiPipelineAlertService(
  dropCreationService,
  identitiesDb
);
