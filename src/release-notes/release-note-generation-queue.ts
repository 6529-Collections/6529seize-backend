import { Logger } from '@/logging';
import { sqs, SQS } from '@/sqs';

export const RELEASE_NOTE_GENERATION_QUEUE_NAME = 'release-note-generation';
export const RELEASE_NOTE_DEPLOYED_AT_PATTERN =
  /T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface ReleaseNoteRunReference {
  readonly service: string;
  readonly run_id: string;
  readonly run_number?: string | null;
  readonly run_url: string;
}

export interface ReleaseNoteGenerationRequest {
  readonly repo: string;
  readonly workflow: string;
  readonly run_id: string;
  readonly run_number?: string | null;
  readonly run_url: string;
  readonly triggered_by_github_login?: string | null;
  readonly sha: string;
  readonly branch?: string | null;
  readonly environment: string;
  readonly service?: string | null;
  readonly prompt_path: string;
  readonly release_group_id: string;
  readonly release_group_services: string[];
  readonly pull_request_number?: number | null;
  readonly contributor_github_logins?: string[];
  readonly publish_release_note?: boolean;
  readonly release_group_runs?: ReleaseNoteRunReference[];
  readonly release_version?: string | null;
  readonly frontend_sha?: string | null;
  readonly deployed_at: string;
}

export interface ReleaseNoteValidationRequest {
  readonly message_type: 'release_validation';
  readonly repo: string;
  readonly workflow: string;
  readonly run_id: string;
  readonly run_number?: string | null;
  readonly run_url: string;
  readonly sha: string;
  readonly release_group_id: string;
  readonly pull_request_number?: number | null;
  readonly status: 'success' | 'failure';
  readonly validation_mode?: 'automatic' | 'manual';
  readonly triggered_by_github_login?: string | null;
}

export class ReleaseNoteGenerationQueue {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(private readonly sqsClient: SQS) {}

  public async enqueueBestEffort(
    request: ReleaseNoteGenerationRequest
  ): Promise<boolean> {
    return this.enqueueMessageBestEffort(request, 'release notes');
  }

  public async enqueue(request: ReleaseNoteGenerationRequest): Promise<void> {
    await this.enqueueMessage(request);
  }

  public async enqueueValidation(
    request: ReleaseNoteValidationRequest
  ): Promise<void> {
    await this.enqueueMessage(request);
  }

  private async enqueueMessage(
    request: ReleaseNoteGenerationRequest | ReleaseNoteValidationRequest
  ): Promise<void> {
    await this.sqsClient.sendToQueueName({
      queueName: RELEASE_NOTE_GENERATION_QUEUE_NAME,
      message: request
    });
  }

  private async enqueueMessageBestEffort(
    request: ReleaseNoteGenerationRequest | ReleaseNoteValidationRequest,
    label: string
  ): Promise<boolean> {
    try {
      await this.enqueueMessage(request);
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to enqueue ${label} for ${request.repo} run ${request.run_id}: ${error}`
      );
      return false;
    }
  }
}

export const releaseNoteGenerationQueue = new ReleaseNoteGenerationQueue(sqs);
