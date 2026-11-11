import { CompetitionEventDispatcher } from './competition-event-dispatcher';
import { CompetitionEventRepository } from './competition-event.repository';
import { NativeCompetitionEvent } from './native-competition-runtime.repository';
import { RequestContext } from '@/request.context';

const event: NativeCompetitionEvent = {
  event_id: 'event',
  event_version: 1,
  event_type: 'COMPETITION_DECISION_COMPLETED',
  occurred_at: 100,
  wave_id: 'wave',
  competition_id: 'competition',
  data: { decision_id: 'decision', winners: ['entry'] }
};

function dependencies() {
  const outbox = {
    claimOutbox: jest.fn(),
    claimPriorityOutbox: jest.fn().mockResolvedValue([]),
    acknowledgeOutbox: jest.fn(),
    retryOutbox: jest.fn(),
    deferOutbox: jest.fn()
  };
  const repository = {
    getContext: jest.fn().mockResolvedValue({
      title: 'Contest',
      lifecycle: 'PUBLISHED',
      published_at: 10,
      visibility_group_id: 'group'
    }),
    listFollowers: jest
      .fn()
      .mockImplementation(async (_wave: string, after: string) =>
        after ? [] : ['follower']
      ),
    getEntrySubmitter: jest.fn().mockResolvedValue('artist'),
    applyEffect: jest.fn(
      async <T>(
        _id: string,
        _key: string,
        apply: (ctx: RequestContext) => Promise<T>,
        ctx: RequestContext
      ) => apply(ctx)
    ) as jest.MockedFunction<CompetitionEventRepository['applyEffect']>,
    getPrivilegedWinners: jest.fn().mockResolvedValue([])
  };
  const sockets = { notifyAboutCompetitionUpdate: jest.fn() };
  const notifier = {
    notifyOfCompetitionLifecycle: jest.fn().mockResolvedValue([7])
  };
  const announcements = { drop: jest.fn().mockResolvedValue([8]) };
  const publishClaim = jest.fn();
  const push = jest.fn();
  const artworkAlerts = { deliver: jest.fn().mockResolvedValue(true) };
  const pushOutbox = { enqueueMany: jest.fn() };
  const dispatcher = new CompetitionEventDispatcher(
    outbox,
    repository,
    sockets,
    notifier,
    announcements,
    publishClaim,
    push,
    () => ['announcement-wave'],
    artworkAlerts,
    pushOutbox
  );
  return {
    dispatcher,
    artworkAlerts,
    pushOutbox,
    outbox,
    repository,
    sockets,
    notifier,
    announcements,
    publishClaim,
    push
  };
}

describe('CompetitionEventDispatcher', () => {
  afterEach(() => jest.restoreAllMocks());

  it('defers partial artwork delivery and acknowledges only after it completes', async () => {
    const deps = dependencies();
    deps.outbox.claimOutbox.mockResolvedValue([
      { id: event.event_id, event, attempts: 1, lease_token: 'lease' }
    ]);
    deps.artworkAlerts.deliver.mockResolvedValueOnce(false);
    await deps.dispatcher.dispatchPending({}, 100);
    expect(deps.outbox.deferOutbox).toHaveBeenCalledWith(
      event.event_id,
      'lease',
      expect.any(Number),
      {}
    );
    expect(deps.outbox.acknowledgeOutbox).not.toHaveBeenCalled();
    expect(deps.outbox.retryOutbox).not.toHaveBeenCalled();
    await deps.dispatcher.dispatchPending({}, 200);
    expect(deps.outbox.acknowledgeOutbox).toHaveBeenCalledTimes(1);
  });

  it('hands off ordinary entry pushes once across partial artwork batches', async () => {
    const deps = dependencies();
    const activated = process.env.PUSH_NOTIFICATIONS_ACTIVATED;
    process.env.PUSH_NOTIFICATIONS_ACTIVATED = 'true';
    try {
      const receipts = new Map<string, unknown>();
      deps.repository.applyEffect.mockImplementation(
        async <T>(
          _event: string,
          key: string,
          apply: (ctx: RequestContext) => Promise<T>,
          ctx: RequestContext = {}
        ) => {
          if (!receipts.has(key)) receipts.set(key, await apply(ctx));
          return receipts.get(key) as T;
        }
      );
      const created = {
        ...event,
        event_type: 'COMPETITION_ENTRY_CREATED',
        data: {
          artwork_alert_eligible: true,
          pending_push_notification_ids: [17, 17, 18]
        }
      };
      deps.artworkAlerts.deliver.mockResolvedValueOnce(false);
      expect(await deps.dispatcher.dispatch(created, {})).toBe(false);
      expect(await deps.dispatcher.dispatch(created, {})).toBe(true);
      expect(deps.pushOutbox.enqueueMany).toHaveBeenCalledTimes(1);
      expect(deps.pushOutbox.enqueueMany).toHaveBeenCalledWith([17, 18], {});
      expect(deps.push).not.toHaveBeenCalled();
    } finally {
      if (activated === undefined)
        delete process.env.PUSH_NOTIFICATIONS_ACTIVATED;
      else process.env.PUSH_NOTIFICATIONS_ACTIVATED = activated;
    }
  });

  it('releases remaining claimed records when the dispatch budget is exhausted', async () => {
    const deps = dependencies();
    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    deps.outbox.claimOutbox.mockResolvedValue([
      { id: 'first', event, attempts: 1, lease_token: 'lease-1' },
      { id: 'second', event, attempts: 1, lease_token: 'lease-2' }
    ]);
    deps.artworkAlerts.deliver.mockImplementationOnce(async () => {
      now = 240_001;
      return false;
    });
    await deps.dispatcher.dispatchPending({}, 0);
    expect(deps.artworkAlerts.deliver).toHaveBeenCalledWith(event, {}, 20_000);
    expect(deps.artworkAlerts.deliver).toHaveBeenCalledTimes(1);
    expect(deps.outbox.deferOutbox.mock.calls.map(([id]) => id)).toEqual([
      'first',
      'second'
    ]);
    expect(deps.outbox.acknowledgeOutbox).not.toHaveBeenCalled();
    expect(deps.outbox.retryOutbox).not.toHaveBeenCalled();
  });

  it('delivers decision results before older ordinary events', async () => {
    const deps = dependencies();
    const delivered: string[] = [];
    deps.sockets.notifyAboutCompetitionUpdate.mockImplementation(
      async (e: NativeCompetitionEvent) => {
        delivered.push(e.event_id);
      }
    );
    const vote = (id: string) => ({
      id,
      event: { ...event, event_id: id, event_type: 'COMPETITION_VOTE_CHANGED' },
      attempts: 1,
      lease_token: id
    });
    deps.outbox.claimPriorityOutbox.mockResolvedValueOnce([
      { id: 'decision', event, attempts: 1, lease_token: 'decision' }
    ]);
    deps.outbox.claimOutbox.mockResolvedValueOnce([
      vote('vote-1'),
      vote('vote-2')
    ]);

    await deps.dispatcher.dispatchPending({}, 100);

    expect(delivered).toEqual(['event', 'vote-1', 'vote-2']);
    expect(deps.outbox.claimPriorityOutbox).toHaveBeenCalledTimes(1);
    expect(deps.outbox.claimOutbox).toHaveBeenCalledTimes(1);
    expect(deps.outbox.acknowledgeOutbox).toHaveBeenCalledTimes(3);
  });

  it('keeps claiming decision results while full batches of them remain', async () => {
    const deps = dependencies();
    const batch = Array.from({ length: 100 }, (_, i) => ({
      id: `d-${i}`,
      event,
      attempts: 1,
      lease_token: `d-${i}`
    }));
    deps.outbox.claimPriorityOutbox
      .mockResolvedValueOnce(batch)
      .mockResolvedValueOnce([]);
    deps.outbox.claimOutbox.mockResolvedValue([]);

    await deps.dispatcher.dispatchPending({}, 100);

    expect(deps.outbox.claimPriorityOutbox).toHaveBeenCalledTimes(2);
    expect(deps.outbox.claimOutbox).toHaveBeenCalledTimes(1);
  });

  it('stops claiming once a shorter budget is spent', async () => {
    const deps = dependencies();
    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    deps.outbox.claimPriorityOutbox.mockResolvedValue([]);
    deps.outbox.claimOutbox.mockResolvedValue([
      { id: 'first', event, attempts: 1, lease_token: 'lease-1' },
      { id: 'second', event, attempts: 1, lease_token: 'lease-2' }
    ]);
    deps.sockets.notifyAboutCompetitionUpdate.mockImplementationOnce(
      async () => {
        now = 60_000;
      }
    );

    await deps.dispatcher.dispatchPending({}, 0, { budgetMs: 60_000 });

    expect(deps.outbox.acknowledgeOutbox.mock.calls.map(([id]) => id)).toEqual([
      'first'
    ]);
    expect(deps.outbox.deferOutbox.mock.calls.map(([id]) => id)).toEqual([
      'second'
    ]);
    expect(deps.outbox.claimOutbox).toHaveBeenCalledTimes(1);
  });

  describe('with a large backlog of decision results', () => {
    const batchOf = (prefix: string, eventType: string) =>
      Array.from({ length: 100 }, (_, i) => ({
        id: `${prefix}-${i}`,
        event: { ...event, event_id: `${prefix}-${i}`, event_type: eventType },
        attempts: 1,
        lease_token: `${prefix}-${i}`
      }));

    it('alternates batches so ordinary events are still claimed every pass', async () => {
      const deps = dependencies();
      const order: string[] = [];
      let priorityBatch = 0;
      let ordinaryBatch = 0;
      deps.outbox.claimPriorityOutbox.mockImplementation(async () => {
        order.push('priority');
        return batchOf(`d${priorityBatch++}`, 'COMPETITION_DECISION_COMPLETED');
      });
      deps.outbox.claimOutbox.mockImplementation(async () => {
        order.push('ordinary');
        return batchOf(`v${ordinaryBatch++}`, 'COMPETITION_VOTE_CHANGED');
      });

      await deps.dispatcher.dispatchPending({}, 100);

      expect(order).toEqual([
        'priority',
        'ordinary',
        'priority',
        'ordinary',
        'priority',
        'ordinary',
        'priority',
        'ordinary',
        'priority',
        'ordinary'
      ]);
      const acknowledged = deps.outbox.acknowledgeOutbox.mock.calls.map(
        ([id]) => id as string
      );
      expect(acknowledged.filter((id) => id.startsWith('v'))).toHaveLength(500);
      expect(acknowledged.filter((id) => id.startsWith('d'))).toHaveLength(500);
    });

    it('gives decision results at most half the time while other events wait', async () => {
      const deps = dependencies();
      let now = 0;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      // Each decision result takes a second to deliver.
      deps.sockets.notifyAboutCompetitionUpdate.mockImplementation(
        async (e: NativeCompetitionEvent) => {
          if (e.event_type === 'COMPETITION_DECISION_COMPLETED') now += 1_000;
        }
      );
      deps.outbox.claimPriorityOutbox.mockImplementation(async () =>
        batchOf('d', 'COMPETITION_DECISION_COMPLETED')
      );
      deps.outbox.claimOutbox.mockImplementation(async () =>
        batchOf('v', 'COMPETITION_VOTE_CHANGED')
      );

      await deps.dispatcher.dispatchPending({}, 0, { budgetMs: 100_000 });

      const acknowledged = deps.outbox.acknowledgeOutbox.mock.calls.map(
        ([id]) => id as string
      );
      // 50 decision results fit in their half; the rest are released and
      // every remaining batch goes to the waiting events.
      expect(acknowledged.filter((id) => id.startsWith('d'))).toHaveLength(50);
      expect(deps.outbox.deferOutbox).toHaveBeenCalledTimes(50);
      expect(deps.outbox.claimPriorityOutbox).toHaveBeenCalledTimes(1);
      expect(deps.outbox.claimOutbox).toHaveBeenCalledTimes(9);
      expect(acknowledged.filter((id) => id.startsWith('v'))).toHaveLength(900);
    });

    it('lets decision results use the whole budget once the rest is drained', async () => {
      const deps = dependencies();
      let now = 0;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      deps.sockets.notifyAboutCompetitionUpdate.mockImplementation(async () => {
        now += 1_000;
      });
      deps.outbox.claimOutbox.mockResolvedValue([]);
      deps.outbox.claimPriorityOutbox
        .mockResolvedValueOnce(batchOf('a', 'COMPETITION_DECISION_COMPLETED'))
        .mockResolvedValueOnce(batchOf('b', 'COMPETITION_DECISION_COMPLETED'));

      await deps.dispatcher.dispatchPending({}, 0, { budgetMs: 100_000 });

      // The first batch keeps to its half while ordinary events may still
      // be waiting; after they turn out drained the second gets the rest.
      expect(deps.outbox.acknowledgeOutbox).toHaveBeenCalledTimes(100);
      expect(deps.outbox.claimOutbox).toHaveBeenCalledTimes(1);
    });
  });

  it('never spends more than four minutes even when given longer', async () => {
    const deps = dependencies();
    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    deps.outbox.claimOutbox.mockImplementation(async () => {
      now += 100_000;
      return Array.from({ length: 100 }, (_, i) => ({
        id: `e-${now}-${i}`,
        event,
        attempts: 1,
        lease_token: 'lease'
      }));
    });

    await deps.dispatcher.dispatchPending({}, 0, { budgetMs: 900_000 });

    expect(deps.outbox.claimOutbox).toHaveBeenCalledTimes(3);
  });

  it.each(['DRAFT', 'ARCHIVED'])(
    'suppresses never-published %s competitions from subscriptions and notifications',
    async (lifecycle) => {
      const deps = dependencies();
      deps.repository.getContext.mockResolvedValue({
        title: 'Private',
        lifecycle,
        published_at: null,
        visibility_group_id: null
      });
      await deps.dispatcher.dispatch(
        { ...event, event_type: 'COMPETITION_ARCHIVED' },
        {}
      );
      expect(deps.sockets.notifyAboutCompetitionUpdate).not.toHaveBeenCalled();
      expect(deps.notifier.notifyOfCompetitionLifecycle).not.toHaveBeenCalled();
    }
  );

  it.each([
    'COMPETITION_PUBLISHED',
    'COMPETITION_UPDATED',
    'COMPETITION_SCHEDULE_CHANGED',
    'COMPETITION_PAUSED',
    'COMPETITION_RESUMED',
    'COMPETITION_STARTED',
    'COMPETITION_ENDED',
    'COMPETITION_CANCELLED',
    'COMPETITION_ARCHIVED'
  ])(
    'updates live views without notifying followers for %s',
    async (eventType) => {
      const deps = dependencies();
      const statusEvent = {
        ...event,
        event_type: eventType,
        data: { changed_fields: ['schedule', 'participation', 'voting'] }
      };
      await deps.dispatcher.dispatch(statusEvent, {});
      expect(deps.sockets.notifyAboutCompetitionUpdate).toHaveBeenCalledWith(
        statusEvent,
        'group',
        {}
      );
      expect(deps.repository.listFollowers).not.toHaveBeenCalled();
      expect(deps.notifier.notifyOfCompetitionLifecycle).not.toHaveBeenCalled();
      expect(deps.push).not.toHaveBeenCalled();
    }
  );

  it('notifies followers of winners with explicit competition context and current wave access', async () => {
    const deps = dependencies();
    await deps.dispatcher.dispatch(event, {});
    expect(deps.sockets.notifyAboutCompetitionUpdate).toHaveBeenCalledWith(
      event,
      'group',
      {}
    );
    expect(deps.notifier.notifyOfCompetitionLifecycle).toHaveBeenCalledWith(
      'follower',
      {
        event_id: 'event',
        event_type: 'COMPETITION_DECISION_COMPLETED',
        wave_id: 'wave',
        competition_id: 'competition',
        competition_title: 'Contest'
      },
      'group',
      {}
    );
    expect(deps.repository.applyEffect).toHaveBeenCalledWith(
      'event',
      'notify:follower',
      expect.any(Function),
      {}
    );
    expect(deps.push).toHaveBeenCalledWith([7]);
  });

  it.each([
    'COMPETITION_ENTRY_DELETED',
    'COMPETITION_ENTRY_DISQUALIFIED',
    'COMPETITION_ENTRY_WITHDRAWN'
  ])(
    'does not send an entry removal notification for %s',
    async (eventType) => {
      const deps = dependencies();
      await deps.dispatcher.dispatch(
        {
          ...event,
          event_type: eventType,
          competition_entry_id: 'entry',
          drop_id: 'drop',
          data: {}
        },
        {}
      );
      expect(deps.repository.listFollowers).not.toHaveBeenCalled();
      expect(deps.notifier.notifyOfCompetitionLifecycle).not.toHaveBeenCalled();
      expect(deps.push).not.toHaveBeenCalled();
    }
  );

  it('does not grant privileged effects from a wave or event capability assertion', async () => {
    const deps = dependencies();
    await deps.dispatcher.dispatch(
      {
        ...event,
        event_type: 'COMPETITION_DECISION_COMPLETED',
        data: {
          decision_id: 'decision',
          capabilities: ['MAIN_STAGE'],
          winners: []
        }
      },
      {}
    );
    expect(deps.publishClaim).not.toHaveBeenCalled();
    expect(deps.announcements.drop).not.toHaveBeenCalled();
  });

  it('publishes claims with verified native context and rechecks designation for announcements', async () => {
    const deps = dependencies();
    deps.repository.getPrivilegedWinners.mockResolvedValue([
      {
        entry_id: 'entry',
        drop_id: 'drop',
        submitter_id: 'artist',
        rank: 1,
        final_rating: 100
      }
    ]);
    await deps.dispatcher.dispatch(
      {
        ...event,
        event_type: 'COMPETITION_DECISION_COMPLETED',
        data: { decision_id: 'decision', winners: ['entry'] }
      },
      {}
    );
    expect(deps.publishClaim).toHaveBeenCalledWith('drop', {
      competition_id: 'competition',
      competition_entry_id: 'entry',
      decision_id: 'decision'
    });
    expect(deps.repository.getPrivilegedWinners).toHaveBeenCalledTimes(2);
    expect(deps.announcements.drop).toHaveBeenCalledWith(
      {
        waves: ['announcement-wave'],
        message: expect.stringContaining(
          '/waves/wave/competitions/competition?entry=entry'
        )
      },
      {}
    );
  });

  it('retries a failed event without acknowledging it or starving the next event', async () => {
    const deps = dependencies();
    deps.outbox.claimOutbox.mockResolvedValue([
      { id: 'failed', event, attempts: 1, lease_token: 'lease-1' },
      {
        id: 'ok',
        event: { ...event, event_id: 'ok' },
        attempts: 1,
        lease_token: 'lease-2'
      }
    ]);
    deps.sockets.notifyAboutCompetitionUpdate.mockRejectedValueOnce(
      new Error('transient')
    );
    await deps.dispatcher.dispatchPending({}, 100);
    expect(deps.outbox.retryOutbox).toHaveBeenCalledWith(
      'failed',
      'lease-1',
      expect.any(Number),
      {}
    );
    expect(deps.outbox.acknowledgeOutbox).toHaveBeenCalledTimes(1);
    expect(deps.outbox.acknowledgeOutbox).toHaveBeenCalledWith(
      'ok',
      'lease-2',
      expect.any(Number),
      {}
    );
  });

  it('retries the same committed entry push IDs after queue handoff fails', async () => {
    const deps = dependencies();
    const queued = {
      ...event,
      event_type: 'COMPETITION_ENTRY_CREATED',
      competition_entry_id: 'entry',
      drop_id: 'drop',
      data: { pending_push_notification_ids: [17, 18] }
    };
    deps.outbox.claimOutbox.mockResolvedValue([
      { id: event.event_id, event: queued, attempts: 1, lease_token: 'lease' }
    ]);
    deps.push
      .mockRejectedValueOnce(new Error('provider private payload'))
      .mockResolvedValue(undefined);
    await deps.dispatcher.dispatchPending({}, 100);
    expect(deps.outbox.acknowledgeOutbox).not.toHaveBeenCalled();
    expect(deps.outbox.retryOutbox).toHaveBeenCalledTimes(1);
    await deps.dispatcher.dispatchPending({}, 200);
    expect(deps.push.mock.calls).toEqual([[[17, 18]], [[17, 18]]]);
    expect(deps.outbox.acknowledgeOutbox).toHaveBeenCalledTimes(1);
    expect(deps.notifier.notifyOfCompetitionLifecycle).not.toHaveBeenCalled();
    expect(deps.repository.listFollowers).not.toHaveBeenCalled();
  });

  it('reuses notification effect receipts when winner push handoff is retried', async () => {
    const deps = dependencies();
    const receipts = new Map<string, unknown>();
    deps.repository.applyEffect.mockImplementation(
      async <T>(
        _event: string,
        key: string,
        apply: (ctx: RequestContext) => Promise<T>,
        ctx: RequestContext = {}
      ): Promise<T> => {
        if (!receipts.has(key)) receipts.set(key, await apply(ctx));
        return receipts.get(key) as T;
      }
    );
    deps.push
      .mockRejectedValueOnce(new Error('queue unavailable'))
      .mockResolvedValue(undefined);
    await expect(deps.dispatcher.dispatch(event, {})).rejects.toThrow(
      'queue unavailable'
    );
    await expect(deps.dispatcher.dispatch(event, {})).resolves.toBe(true);
    expect(deps.notifier.notifyOfCompetitionLifecycle).toHaveBeenCalledTimes(1);
    expect(deps.push.mock.calls).toEqual([[[7]], [[7]]]);
  });
});
