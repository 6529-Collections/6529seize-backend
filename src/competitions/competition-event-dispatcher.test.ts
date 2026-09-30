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
    acknowledgeOutbox: jest.fn(),
    retryOutbox: jest.fn()
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
  const dispatcher = new CompetitionEventDispatcher(
    outbox,
    repository,
    sockets,
    notifier,
    announcements,
    publishClaim,
    push,
    () => ['announcement-wave']
  );
  return {
    dispatcher,
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
    await expect(deps.dispatcher.dispatch(event, {})).resolves.toBeUndefined();
    expect(deps.notifier.notifyOfCompetitionLifecycle).toHaveBeenCalledTimes(1);
    expect(deps.push.mock.calls).toEqual([[[7]], [[7]]]);
  });
});
