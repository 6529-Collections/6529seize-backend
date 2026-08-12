import { SQS } from '@/sqs';
import {
  RELEASE_NOTE_GENERATION_QUEUE_NAME,
  ReleaseNoteGenerationQueue,
  ReleaseNoteGenerationRequest,
  ReleaseNoteValidationRequest
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

  it('rejects a required release-note enqueue when the queue is unavailable', async () => {
    const queue = new ReleaseNoteGenerationQueue({
      sendToQueueName: jest.fn().mockRejectedValue(new Error('queue down'))
    } as unknown as SQS);

    await expect(queue.enqueue(buildRequest())).rejects.toThrow('queue down');
  });

  it('sends validation work to the existing release-note queue', async () => {
    const sendToQueueName = jest.fn().mockResolvedValue(undefined);
    const queue = new ReleaseNoteGenerationQueue({
      sendToQueueName
    } as unknown as SQS);
    const validation: ReleaseNoteValidationRequest = {
      message_type: 'release_validation',
      repo: '6529-Collections/6529seize-frontend',
      workflow: 'Web Deploy - PROD',
      run_id: '456',
      run_number: '12',
      run_url:
        'https://github.com/6529-Collections/6529seize-frontend/actions/runs/456',
      sha: 'a'.repeat(40),
      release_group_id: 'frontend-release',
      status: 'success'
    };

    await queue.enqueueValidation(validation);

    expect(sendToQueueName).toHaveBeenCalledWith({
      queueName: RELEASE_NOTE_GENERATION_QUEUE_NAME,
      message: validation
    });
  });

  it('rejects validation when the queue does not accept it', async () => {
    const queue = new ReleaseNoteGenerationQueue({
      sendToQueueName: jest.fn().mockRejectedValue(new Error('queue down'))
    } as unknown as SQS);

    await expect(
      queue.enqueueValidation({
        message_type: 'release_validation',
        repo: '6529-Collections/6529seize-frontend',
        workflow: 'Web Deploy - PROD',
        run_id: '456',
        run_url:
          'https://github.com/6529-Collections/6529seize-frontend/actions/runs/456',
        sha: 'a'.repeat(40),
        release_group_id: 'frontend-release',
        status: 'success'
      })
    ).rejects.toThrow('queue down');
  });
});
