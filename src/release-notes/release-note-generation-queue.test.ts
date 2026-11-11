import { SQS } from '@/sqs';
import {
  RELEASE_NOTE_GENERATION_QUEUE_NAME,
  RELEASE_NOTE_RETRY_HOPS_ATTRIBUTE,
  MAX_RELEASE_NOTE_RETRY_HOPS,
  parseReleaseNoteRetryHops,
  ReleaseNoteGenerationQueue,
  ReleaseNoteGenerationRequest
} from './release-note-generation-queue';

function buildRequest(): ReleaseNoteGenerationRequest {
  return {
    repo: '6529-Collections/6529seize-backend',
    workflow: 'Deploy a service',
    run_id: '123',
    run_url:
      'https://github.com/6529-Collections/6529seize-backend/actions/runs/123',
    sha: 'abc123',
    environment: 'prod',
    service: 'api',
    prompt_path: 'ops/release-notes/release-notes.prompt.md',
    release_group_id: 'release-group',
    release_group_services: ['api'],
    pull_request_number: 42,
    publish_release_note: true,
    deployed_at: '2026-07-13T11:38:00.000Z'
  };
}

describe('ReleaseNoteGenerationQueue', () => {
  it.each([
    [60_000, 60],
    [1001, 2],
    [7_200_000, 900],
    [0, 1]
  ])(
    'queues pending work with a bounded delay of %i ms',
    async (delayMs, seconds) => {
      const sendToQueueName = jest.fn().mockResolvedValue(undefined);
      const queue = new ReleaseNoteGenerationQueue({
        sendToQueueName
      } as unknown as SQS);
      const request = buildRequest();
      await queue.enqueueRetry(request, delayMs);
      expect(sendToQueueName).toHaveBeenCalledWith({
        queueName: RELEASE_NOTE_GENERATION_QUEUE_NAME,
        message: request,
        delaySeconds: seconds,
        messageAttributes: {
          [RELEASE_NOTE_RETRY_HOPS_ATTRIBUTE]: {
            DataType: 'Number',
            StringValue: '1'
          }
        }
      });
    }
  );

  it('fails a retry handoff so the worker cannot acknowledge unscheduled work', async () => {
    const queue = new ReleaseNoteGenerationQueue({
      sendToQueueName: jest.fn().mockRejectedValue(new Error('queue down'))
    } as unknown as SQS);
    await expect(queue.enqueueRetry(buildRequest(), 60_000)).rejects.toThrow(
      'queue down'
    );
  });

  it('preserves the chain budget across delayed handoffs', async () => {
    const sendToQueueName = jest.fn().mockResolvedValue(undefined);
    const queue = new ReleaseNoteGenerationQueue({
      sendToQueueName
    } as unknown as SQS);
    await queue.enqueueRetry(
      buildRequest(),
      60_000,
      MAX_RELEASE_NOTE_RETRY_HOPS
    );
    expect(sendToQueueName).toHaveBeenCalledWith(
      expect.objectContaining({
        messageAttributes: {
          [RELEASE_NOTE_RETRY_HOPS_ATTRIBUTE]: {
            DataType: 'Number',
            StringValue: String(MAX_RELEASE_NOTE_RETRY_HOPS)
          }
        }
      })
    );
    await expect(
      queue.enqueueRetry(
        buildRequest(),
        60_000,
        MAX_RELEASE_NOTE_RETRY_HOPS + 1
      )
    ).rejects.toThrow('saved pending work requires operator recovery');
    expect(sendToQueueName).toHaveBeenCalledTimes(1);
  });

  it.each(['-1', '1.5', '', 'NaN', '11'])(
    'rejects invalid retry hop metadata %s',
    (value) => {
      expect(() => parseReleaseNoteRetryHops(value)).toThrow(
        'Invalid release-note retry hop count'
      );
    }
  );

  it('starts external deliveries at zero and accepts bounded internal retry metadata', () => {
    expect(parseReleaseNoteRetryHops(undefined)).toBe(0);
    expect(parseReleaseNoteRetryHops('10')).toBe(10);
  });

  it('sends release work to the named queue', async () => {
    const sendToQueueName = jest.fn().mockResolvedValue(undefined);
    const queue = new ReleaseNoteGenerationQueue({
      sendToQueueName
    } as unknown as SQS);
    const request = buildRequest();

    await expect(queue.enqueueBestEffort(request)).resolves.toBe(true);

    expect(sendToQueueName).toHaveBeenCalledWith({
      queueName: RELEASE_NOTE_GENERATION_QUEUE_NAME,
      message: request
    });
  });

  it('reports a best-effort enqueue failure without rejecting', async () => {
    const queue = new ReleaseNoteGenerationQueue({
      sendToQueueName: jest.fn().mockRejectedValue(new Error('queue down'))
    } as unknown as SQS);

    await expect(queue.enqueueBestEffort(buildRequest())).resolves.toBe(false);
  });
});
