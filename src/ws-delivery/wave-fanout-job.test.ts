import {
  buildDropFramesJobs,
  DropFramesJob,
  jobByteLength,
  parseWaveFanoutJob,
  QueuedRecipient,
  WAVE_FANOUT_JOB_VERSION,
  WAVE_FANOUT_MAX_MESSAGE_BYTES
} from './wave-fanout-job';
import { WsMessageType } from '@/api/ws/ws-message';

function base(
  content = 'hello'
): Omit<DropFramesJob, 'v' | 'kind' | 'chunk' | 'recipients'> {
  return {
    update_type: WsMessageType.DROP_UPDATE,
    server_received_at: 1,
    enqueued_at: 2,
    drop: { id: 'drop-1', parts: [{ content }] } as never,
    hidden_drop_ids: [],
    author_ids_by_drop_id: []
  };
}

const recipients = (count: number): QueuedRecipient[] =>
  Array.from({ length: count }, (_, index) => ({
    c: `connection-${index}`,
    p: index % 3 === 0 ? null : `profile-${index}`,
    e: 4102444800
  }));

describe('wave fan-out jobs', () => {
  it('chunks recipients in order and numbers the chunks', () => {
    const { jobs, unqueueable } = buildDropFramesJobs(
      base(),
      recipients(10),
      4
    );
    expect(unqueueable).toEqual([]);
    expect(jobs.map((job) => job.recipients.length)).toEqual([4, 4, 2]);
    expect(jobs.map((job) => job.chunk)).toEqual([0, 1, 2]);
    expect(jobs.flatMap((job) => job.recipients)).toEqual(recipients(10));
    expect(jobs[0]).toMatchObject({
      v: WAVE_FANOUT_JOB_VERSION,
      kind: 'drop_frames',
      server_received_at: 1
    });
  });

  it('halves a chunk until it fits in one SQS message', () => {
    const big = 'x'.repeat(150 * 1024);
    const many = recipients(2000);
    const { jobs, unqueueable } = buildDropFramesJobs(base(big), many, 2000);
    expect(unqueueable).toEqual([]);
    expect(jobs.length).toBeGreaterThan(1);
    for (const job of jobs) {
      expect(jobByteLength(job)).toBeLessThanOrEqual(
        WAVE_FANOUT_MAX_MESSAGE_BYTES
      );
    }
    expect(jobs.flatMap((job) => job.recipients)).toEqual(many);
    expect(jobs.map((job) => job.chunk)).toEqual(
      jobs.map((_job, index) => index)
    );
  });

  it('returns recipients of a drop too large for any message for inline delivery', () => {
    const { jobs, unqueueable } = buildDropFramesJobs(
      base('x'.repeat(WAVE_FANOUT_MAX_MESSAGE_BYTES)),
      recipients(3),
      10
    );
    expect(jobs).toEqual([]);
    expect(unqueueable).toEqual(recipients(3));
  });

  it('round-trips jobs and rejects unknown or malformed bodies', () => {
    const [job] = buildDropFramesJobs(base(), recipients(2), 10).jobs;
    expect(parseWaveFanoutJob(JSON.stringify(job))).toEqual(job);
    const effects = {
      v: WAVE_FANOUT_JOB_VERSION,
      kind: 'drop_created_effects',
      enqueued_at: 1,
      drop_id: 'drop-1',
      wave_id: 'wave-1',
      author_id: 'author-1',
      pending_push_notification_ids: [1],
      dm_unread_recipient_ids: []
    };
    expect(parseWaveFanoutJob(JSON.stringify(effects))).toEqual({
      ...effects,
      collaborator_ids: []
    });
    expect(() => parseWaveFanoutJob('{"v":2,"kind":"drop_frames"}')).toThrow(
      'version'
    );
    expect(() => parseWaveFanoutJob('{"v":1,"kind":"other"}')).toThrow('kind');
    expect(() =>
      parseWaveFanoutJob('{"v":1,"kind":"drop_frames","drop":{}}')
    ).toThrow('Malformed');
    expect(() =>
      parseWaveFanoutJob('{"v":1,"kind":"drop_created_effects"}')
    ).toThrow('Malformed');
    expect(() => parseWaveFanoutJob('not json')).toThrow();
  });
});
