import { Logger } from '@/logging';
import { sqs, SQS } from '@/sqs';

export const RELEASE_NOTE_GENERATION_QUEUE_NAME = 'release-note-generation';
export const RELEASE_NOTE_RETRY_HOPS_ATTRIBUTE = 'ReleaseNoteRetryHops';
// Keep deliberate retries below Lambda's approximately 16-hop recursion guard.
// The original notification may already have passed through another Lambda.
export const MAX_RELEASE_NOTE_RETRY_HOPS = 10;
export const RELEASE_NOTE_DEPLOYED_AT_PATTERN =
  /T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseReleaseNoteRetryHops(value: string | undefined): number {
  if (value === undefined) return 0;
  const hops = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(hops) ||
    hops > MAX_RELEASE_NOTE_RETRY_HOPS
  ) {
    throw new TypeError('Invalid release-note retry hop count');
  }
  return hops;
}

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

export class ReleaseNoteGenerationQueue {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(private readonly sqsClient: SQS) {}

  /** A pending job must hand off its next delivery before acknowledging this one. */
  public async enqueueRetry(
    request: ReleaseNoteGenerationRequest,
    delayMs: number,
    retryHops = 1
  ): Promise<void> {
    if (
      !Number.isSafeInteger(retryHops) ||
      retryHops < 1 ||
      retryHops > MAX_RELEASE_NOTE_RETRY_HOPS
    ) {
      throw new Error(
        `Release-note retry handoff limit reached for ${request.repo} run ${request.run_id}; saved pending work requires operator recovery`
      );
    }
    await this.sqsClient.sendToQueueName({
      queueName: RELEASE_NOTE_GENERATION_QUEUE_NAME,
      message: request,
      delaySeconds: Math.min(900, Math.max(1, Math.ceil(delayMs / 1000))),
      messageAttributes: {
        [RELEASE_NOTE_RETRY_HOPS_ATTRIBUTE]: {
          DataType: 'Number',
          StringValue: String(retryHops)
        }
      }
    });
  }

  public async enqueueBestEffort(
    request: ReleaseNoteGenerationRequest
  ): Promise<boolean> {
    try {
      await this.sqsClient.sendToQueueName({
        queueName: RELEASE_NOTE_GENERATION_QUEUE_NAME,
        message: request
      });
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to enqueue release notes for ${request.repo} run ${request.run_id}: ${error}`
      );
      return false;
    }
  }
}

export const releaseNoteGenerationQueue = new ReleaseNoteGenerationQueue(sqs);
