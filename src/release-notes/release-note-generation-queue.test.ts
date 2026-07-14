import { SQS } from '@/sqs';
import {
  RELEASE_NOTE_GENERATION_QUEUE_NAME,
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
    deployed_at: '2026-07-13T11:38:00.000Z'
  };
}

describe('ReleaseNoteGenerationQueue', () => {
  it('sends release work to the named queue', async () => {
    const sendToQueueName = jest.fn().mockResolvedValue(undefined);
    const queue = new ReleaseNoteGenerationQueue({
      sendToQueueName
    } as unknown as SQS);
    const request = buildRequest();

    await queue.enqueueBestEffort(request);

    expect(sendToQueueName).toHaveBeenCalledWith({
      queueName: RELEASE_NOTE_GENERATION_QUEUE_NAME,
      message: request
    });
  });

  it('does not reject when enqueueing fails', async () => {
    const queue = new ReleaseNoteGenerationQueue({
      sendToQueueName: jest.fn().mockRejectedValue(new Error('queue down'))
    } as unknown as SQS);

    await expect(
      queue.enqueueBestEffort(buildRequest())
    ).resolves.toBeUndefined();
  });
});
