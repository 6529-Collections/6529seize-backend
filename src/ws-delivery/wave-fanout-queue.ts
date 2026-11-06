import {
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient
} from '@aws-sdk/client-sqs';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Logger } from '@/logging';
import { jobByteLength, WaveFanoutJob } from './wave-fanout-job';

export const WAVE_FANOUT_QUEUE_NAME = 'wave-fanout';

/** `WS_ASYNC_FANOUT=true` turns on reply-after-commit (waves 1.1). */
export function isAsyncFanoutEnabled(): boolean {
  return process.env.WS_ASYNC_FANOUT === 'true';
}

function positiveInt(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

/** Recipients sent inside the request; the rest go to the worker. */
export function inlineFanoutLimit(): number {
  return positiveInt('WS_INLINE_FANOUT_MAX', 64, 1000);
}

/** Recipients per queued job; each job is sent by one worker invocation. */
export function fanoutChunkSize(): number {
  return positiveInt('WS_FANOUT_CHUNK_SIZE', 150, 1000);
}

/**
 * Hands jobs to the wave fan-out worker. Every send is awaited: a job is
 * either accepted by SQS before the caller continues or returned to the
 * caller, which then does the work inline. Nothing is fired and forgotten.
 */
export interface WaveFanoutQueue {
  /** Returns the jobs that were NOT accepted. */
  enqueue(jobs: readonly WaveFanoutJob[]): Promise<WaveFanoutJob[]>;
}

export class SqsWaveFanoutQueue implements WaveFanoutQueue {
  private readonly logger = Logger.get(this.constructor.name);
  private client: SQSClient | null = null;
  private queueUrl: Promise<string> | null = null;

  private getClient(): SQSClient {
    this.client ??= new SQSClient({
      region: process.env.AWS_REGION,
      maxAttempts: 2,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 1000,
        requestTimeout: 2000,
        throwOnRequestTimeout: true
      })
    });
    return this.client;
  }

  private getQueueUrl(): Promise<string> {
    if (process.env.WAVE_FANOUT_QUEUE_URL)
      return Promise.resolve(process.env.WAVE_FANOUT_QUEUE_URL);
    this.queueUrl ??= this.getClient()
      .send(new GetQueueUrlCommand({ QueueName: WAVE_FANOUT_QUEUE_NAME }))
      .then((response) => {
        if (!response.QueueUrl) throw new Error('wave-fanout queue not found');
        return response.QueueUrl;
      })
      .catch((error: unknown) => {
        this.queueUrl = null;
        throw error;
      });
    return this.queueUrl;
  }

  async enqueue(jobs: readonly WaveFanoutJob[]): Promise<WaveFanoutJob[]> {
    if (!jobs.length) return [];
    let queueUrl: string;
    try {
      queueUrl = await this.getQueueUrl();
    } catch (error) {
      this.logger.error({ code: 'WAVE_FANOUT_QUEUE_UNAVAILABLE', error });
      return [...jobs];
    }
    const results = await Promise.allSettled(
      jobs.map((job) =>
        this.getClient().send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(job)
          })
        )
      )
    );
    const rejected = jobs.filter(
      (_job, index) => results[index].status === 'rejected'
    );
    if (rejected.length) {
      this.logger.error({
        code: 'WAVE_FANOUT_ENQUEUE_FAILED',
        failed: rejected.length,
        total: jobs.length,
        largest_bytes: Math.max(...rejected.map(jobByteLength))
      });
    }
    return rejected;
  }
}

export const waveFanoutQueue: WaveFanoutQueue = new SqsWaveFanoutQueue();
