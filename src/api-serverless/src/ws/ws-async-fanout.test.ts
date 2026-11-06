import { WsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import { WsMessageType } from '@/api/ws/ws-message';
import { ApiWaveCreditType } from '@/api/generated/models/ApiWaveCreditType';
import { ApiWaveCreditScope } from '@/api/generated/models/ApiWaveCreditScope';
import { competitionAnonymityService } from '@/competitions/competition-anonymity';
import { DropFramesJob, WaveFanoutJob } from '@/ws-delivery/wave-fanout-job';

function createDrop() {
  return {
    id: 'drop-1',
    serial_no: 42,
    drop_type: 'CHAT',
    author: { id: 'author-1', subscribed_actions: [] },
    wave: {
      id: 'wave-1',
      visibility_group_id: null,
      voting_credit_type: ApiWaveCreditType.Tdh,
      voting_credit_scope: ApiWaveCreditScope.Wave
    },
    viewer_context: { author_blocked: false, drop_hidden: false },
    moderation: { status: 'VISIBLE', can_view: true },
    parts: [{ content: 'hello' }]
  } as any;
}

const recipient = (index: number, waveId: string | null = null) => ({
  connectionId: `c-${index}`,
  profileId: `p-${index}`,
  wave_id: waveId,
  jwtExpiry: 4102444800
});

function frameBody(message: string) {
  const { sent_at, server_received_at, ...frame } = JSON.parse(message);
  return frame;
}

function harness({
  recipients,
  viewing = [],
  enqueue = async () => [] as WaveFanoutJob[]
}: {
  recipients: ReturnType<typeof recipient>[];
  viewing?: string[];
  enqueue?: (jobs: readonly WaveFanoutJob[]) => Promise<WaveFanoutJob[]>;
}) {
  const appWebSockets = {
    send: jest.fn().mockResolvedValue({ status: 'sent' })
  };
  const connections = {
    getCurrentlyOnlineCommunityMemberConnectionIds: jest
      .fn()
      .mockResolvedValue(recipients),
    findProfileIdsViewingWave: jest.fn().mockResolvedValue(new Set(viewing))
  };
  const viewerContexts = jest.fn().mockResolvedValue({});
  const queue = { enqueue: jest.fn(enqueue) };
  const notifier = new WsListenersNotifier(
    appWebSockets as never,
    connections as never,
    { getViewerContextsForDrop: viewerContexts },
    queue
  );
  const sentTo = () =>
    appWebSockets.send.mock.calls.map(([call]) => call.connectionId as string);
  return {
    notifier,
    appWebSockets,
    connections,
    queue,
    viewerContexts,
    sentTo
  };
}

describe('reply after commit (waves 1.1)', () => {
  const env = { ...process.env };

  beforeEach(() => {
    jest
      .spyOn(competitionAnonymityService, 'hiddenDropIds')
      .mockResolvedValue(new Set());
    process.env.WS_ASYNC_FANOUT = 'true';
    process.env.WS_INLINE_FANOUT_MAX = '3';
    process.env.WS_FANOUT_CHUNK_SIZE = '3';
  });

  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('keeps today’s inline fan-out when the flag is off', async () => {
    delete process.env.WS_ASYNC_FANOUT;
    const h = harness({
      recipients: Array.from({ length: 10 }, (_, i) => recipient(i))
    });
    await h.notifier.notifyAboutDropUpdate(createDrop(), {});
    expect(h.appWebSockets.send).toHaveBeenCalledTimes(10);
    expect(h.queue.enqueue).not.toHaveBeenCalled();
    expect(h.connections.findProfileIdsViewingWave).not.toHaveBeenCalled();
  });

  it('sends a small audience inline without touching the queue', async () => {
    const h = harness({ recipients: [recipient(0), recipient(1)] });
    await h.notifier.notifyAboutDropUpdate(createDrop(), {});
    expect(h.sentTo()).toEqual(['c-0', 'c-1']);
    expect(h.queue.enqueue).not.toHaveBeenCalled();
  });

  it('sends open-wave viewers inline and queues the rest in ordered chunks', async () => {
    const recipients = [
      recipient(0),
      recipient(1),
      recipient(2, 'wave-1'),
      recipient(3),
      recipient(4),
      recipient(5),
      recipient(6),
      recipient(7),
      recipient(8),
      recipient(9)
    ];
    const h = harness({ recipients, viewing: ['p-7'] });

    await h.notifier.notifyAboutDropUpdate(createDrop(), {});

    // Subscribed socket and the app socket of a profile viewing the wave
    // first, then the remaining inline budget.
    expect(h.sentTo()).toEqual(['c-2', 'c-7', 'c-0']);
    expect(h.connections.findProfileIdsViewingWave).toHaveBeenCalledWith(
      'wave-1',
      {}
    );
    const jobs = h.queue.enqueue.mock.calls[0][0] as DropFramesJob[];
    expect(jobs.map((job) => job.recipients.map((r) => r.c))).toEqual([
      ['c-1', 'c-3', 'c-4'],
      ['c-5', 'c-6', 'c-8'],
      ['c-9']
    ]);
    expect(jobs[0]).toMatchObject({
      kind: 'drop_frames',
      chunk: 0,
      update_type: WsMessageType.DROP_UPDATE,
      drop: { id: 'drop-1' }
    });
    expect(jobs[0].recipients[0]).toEqual({
      c: 'c-1',
      p: 'p-1',
      e: 4102444800
    });
    // Payload inputs were read for the inline recipients only.
    expect(h.viewerContexts.mock.calls[0][0].viewerProfileIds).toEqual([
      'p-2',
      'p-7',
      'p-0'
    ]);
  });

  it('never loses recipients the queue did not accept', async () => {
    const h = harness({
      recipients: Array.from({ length: 8 }, (_, i) => recipient(i)),
      enqueue: async (jobs) => [jobs[1]]
    });

    await h.notifier.notifyAboutDropUpdate(createDrop(), {});

    // Inline budget (3) plus the rejected second chunk (c-6, c-7).
    expect(h.sentTo()).toEqual(['c-0', 'c-1', 'c-2', 'c-6', 'c-7']);
  });

  it('does not finish until the queue has accepted the hand-off', async () => {
    let accept!: () => void;
    const accepted = new Promise<WaveFanoutJob[]>((resolve) => {
      accept = () => resolve([]);
    });
    const h = harness({
      recipients: Array.from({ length: 5 }, (_, i) => recipient(i)),
      enqueue: () => accepted
    });
    let done = false;
    const fanout = h.notifier
      .notifyAboutDropUpdate(createDrop(), {})
      .then(() => {
        done = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.appWebSockets.send).toHaveBeenCalledTimes(3);
    expect(done).toBe(false);
    accept();
    await fanout;
    expect(done).toBe(true);
  });

  it('delivers a queued chunk with exactly the inline payload', async () => {
    const inline = harness({ recipients: [recipient(4)] });
    await inline.notifier.notifyAboutDropUpdate(createDrop(), {});
    const queued = harness({ recipients: [] });
    await queued.notifier.deliverQueuedDropFrames({
      v: 1,
      kind: 'drop_frames',
      update_type: WsMessageType.DROP_UPDATE,
      server_received_at: 1000,
      enqueued_at: 2000,
      chunk: 0,
      drop: createDrop(),
      hidden_drop_ids: [],
      author_ids_by_drop_id: [],
      recipients: [{ c: 'c-4', p: 'p-4', e: 4102444800 }]
    });
    const [[inlineCall]] = inline.appWebSockets.send.mock.calls;
    const [[queuedCall]] = queued.appWebSockets.send.mock.calls;
    expect(queuedCall.connectionId).toBe('c-4');
    expect(queuedCall.jwtExpiry).toBe(4102444800);
    expect(frameBody(queuedCall.message)).toEqual(
      frameBody(inlineCall.message)
    );
    expect(JSON.parse(queuedCall.message).server_received_at).toBe(1000);
  });

  it('retries a chunk that fails before sending, but not one that failed mid-send', async () => {
    const job: DropFramesJob = {
      v: 1,
      kind: 'drop_frames',
      update_type: WsMessageType.DROP_UPDATE,
      server_received_at: null,
      enqueued_at: Date.now(),
      chunk: 0,
      drop: createDrop(),
      hidden_drop_ids: [],
      author_ids_by_drop_id: [],
      recipients: [{ c: 'c-1', p: 'p-1', e: 4102444800 }]
    };
    const beforeSend = harness({ recipients: [] });
    beforeSend.viewerContexts.mockRejectedValue(new Error('db down'));
    await expect(
      beforeSend.notifier.deliverQueuedDropFrames(job)
    ).rejects.toThrow('db down');
    expect(beforeSend.appWebSockets.send).not.toHaveBeenCalled();

    const midSend = harness({ recipients: [] });
    midSend.appWebSockets.send.mockRejectedValue(new Error('socket error'));
    (midSend.notifier as any).logger = { error: jest.fn() };
    await expect(
      midSend.notifier.deliverQueuedDropFrames(job)
    ).resolves.toBeUndefined();
    expect((midSend.notifier as any).logger.error).toHaveBeenCalled();
  });
});
