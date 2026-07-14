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
  readonly sha: string;
  readonly branch?: string | null;
  readonly environment: string;
  readonly service?: string | null;
  readonly prompt_path: string;
  readonly release_group_id: string;
  readonly release_group_services: string[];
  readonly release_group_runs?: ReleaseNoteRunReference[];
  readonly deployed_at: string;
}

export class ReleaseNoteGenerationQueue {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(private readonly sqsClient: SQS) {}

  public async enqueueBestEffort(
    request: ReleaseNoteGenerationRequest
  ): Promise<void> {
    try {
      await this.sqsClient.sendToQueueName({
        queueName: RELEASE_NOTE_GENERATION_QUEUE_NAME,
        message: request
      });
    } catch (error) {
      this.logger.error(
        `Failed to enqueue release notes for ${request.repo} run ${request.run_id}: ${error}`
      );
    }
  }
}

export const releaseNoteGenerationQueue = new ReleaseNoteGenerationQueue(sqs);
