import {
  buildDropFramesJobs,
  DropFramesJob,
  jobByteLength,
  asDropCreatedEffectsJob,
  asDropFramesJob,
  DEFAULT_WAVE_JOB_KIND,
  parseWaveJobEnvelope,
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

  it('does not halve a drop that cannot fit with a single recipient', () => {
    const stringify = jest.spyOn(JSON, 'stringify');
    try {
      const { jobs, unqueueable } = buildDropFramesJobs(
        base('x'.repeat(WAVE_FANOUT_MAX_MESSAGE_BYTES)),
        recipients(1000),
        10
      );
      expect(jobs).toEqual([]);
      expect(unqueueable).toHaveLength(1000);
      expect(stringify).toHaveBeenCalledTimes(1);
    } finally {
      stringify.mockRestore();
    }
    expect(buildDropFramesJobs(base(), [], 10)).toEqual({
      jobs: [],
      unqueueable: []
    });
  });

  it('reads job envelopes and validates the built-in kinds strictly', () => {
    const [job] = buildDropFramesJobs(base(), recipients(2), 10).jobs;
    const envelope = parseWaveJobEnvelope(JSON.stringify(job));
    expect(envelope.kind).toBe('drop_frames');
    expect(asDropFramesJob(envelope.job)).toEqual(job);
    const { kind, ...withoutKind } = job;
    expect(parseWaveJobEnvelope(JSON.stringify(withoutKind)).kind).toBe(
      DEFAULT_WAVE_JOB_KIND
    );
    expect(asDropFramesJob(withoutKind)).toEqual(job);
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
    expect(asDropCreatedEffectsJob(effects)).toEqual({
      ...effects,
      collaborator_ids: []
    });
    expect(() => asDropFramesJob({ v: 2 })).toThrow('version');
    expect(() => asDropFramesJob({ v: 1, drop: {} })).toThrow('Malformed');
    expect(() => asDropCreatedEffectsJob({ v: 1 })).toThrow('Malformed');
    expect(() => parseWaveJobEnvelope('[1]')).toThrow('not an object');
    expect(() => parseWaveJobEnvelope('not json')).toThrow();
  });
});
