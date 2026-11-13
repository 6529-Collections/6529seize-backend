import fc from 'fast-check';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import {
  APNS_COLLAPSE_ID_MAX_BYTES,
  getPushNotificationGrouping,
  PushNotificationGroupingSource
} from '@/pushNotificationsHandler/push-notification-grouping';

function source(
  overrides: Partial<PushNotificationGroupingSource> = {}
): PushNotificationGroupingSource {
  return {
    cause: IdentityNotificationCause.DROP_REPLIED,
    identity_id: 'recipient-1',
    additional_identity_id: 'actor-1',
    related_drop_id: 'drop-1',
    wave_id: 'wave-1',
    additional_data: {},
    ...overrides
  };
}

const NEVER_COLLAPSED = [
  IdentityNotificationCause.IDENTITY_MENTIONED,
  IdentityNotificationCause.DROP_QUOTED,
  IdentityNotificationCause.DROP_REPLIED,
  IdentityNotificationCause.DROP_POLL_VOTED,
  IdentityNotificationCause.WAVE_CREATED,
  IdentityNotificationCause.COMPETITION_LIFECYCLE,
  IdentityNotificationCause.ALL_DROPS,
  IdentityNotificationCause.PRIORITY_ALERT
];

const ACTOR_ITEM_UPDATES = [
  IdentityNotificationCause.DROP_VOTED,
  IdentityNotificationCause.DROP_REACTED,
  IdentityNotificationCause.DROP_BOOSTED
];

describe('getPushNotificationGrouping', () => {
  it.each(NEVER_COLLAPSED)(
    'never collapses distinct %s notifications',
    (cause) => {
      const first = getPushNotificationGrouping(
        source({ cause, additional_identity_id: 'actor-1' })
      );
      const second = getPushNotificationGrouping(
        source({ cause, additional_identity_id: 'actor-1' })
      );
      expect(first.collapseId).toBeUndefined();
      expect(second.collapseId).toBeUndefined();
      expect(first.threadId).toBe(second.threadId);
    }
  );

  it('threads every notification of one recipient and wave together', () => {
    const threads = Object.values(IdentityNotificationCause).map(
      (cause) => getPushNotificationGrouping(source({ cause })).threadId
    );
    expect(new Set(threads).size).toBe(1);
    expect(threads[0]).toMatch(/^wave:[0-9a-f]{32}$/);
  });

  it('separates threads by wave and by recipient profile', () => {
    const base = getPushNotificationGrouping(source()).threadId;
    expect(
      getPushNotificationGrouping(source({ wave_id: 'wave-2' })).threadId
    ).not.toBe(base);
    expect(
      getPushNotificationGrouping(source({ identity_id: 'recipient-2' }))
        .threadId
    ).not.toBe(base);
  });

  it('threads wave-less profile notifications by topic', () => {
    const thread = (cause: IdentityNotificationCause) =>
      getPushNotificationGrouping(source({ cause, wave_id: null })).threadId;
    expect(thread(IdentityNotificationCause.IDENTITY_REP)).toBe(
      thread(IdentityNotificationCause.IDENTITY_NIC)
    );
    expect(thread(IdentityNotificationCause.IDENTITY_REP)).not.toBe(
      thread(IdentityNotificationCause.IDENTITY_SUBSCRIBED)
    );
    expect(thread(IdentityNotificationCause.SUBSCRIPTION_COVERAGE)).toMatch(
      /^profile:[0-9a-f]{32}$/
    );
  });

  it.each(ACTOR_ITEM_UPDATES)(
    'collapses repeated %s updates only for the same actor and drop',
    (cause) => {
      const collapse = (overrides: Partial<PushNotificationGroupingSource>) =>
        getPushNotificationGrouping(source({ cause, ...overrides })).collapseId;
      const base = collapse({});
      expect(base).toBeDefined();
      expect(collapse({})).toBe(base);
      expect(collapse({ additional_identity_id: 'actor-2' })).not.toBe(base);
      expect(collapse({ related_drop_id: 'drop-2' })).not.toBe(base);
      expect(collapse({ identity_id: 'recipient-2' })).not.toBe(base);
      expect(collapse({ additional_identity_id: null })).toBeUndefined();
      expect(collapse({ related_drop_id: null })).toBeUndefined();
    }
  );

  it('keeps vote, reaction and boost updates for one drop separate', () => {
    const ids = ACTOR_ITEM_UPDATES.map(
      (cause) => getPushNotificationGrouping(source({ cause })).collapseId
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('collapses REP updates per rater and category', () => {
    const collapse = (
      overrides: Partial<PushNotificationGroupingSource>,
      category: unknown = 'Art'
    ) =>
      getPushNotificationGrouping(
        source({
          cause: IdentityNotificationCause.IDENTITY_REP,
          wave_id: null,
          additional_data: { category, amount: 5 },
          ...overrides
        })
      ).collapseId;
    const base = collapse({});
    expect(base).toMatch(/^rep:[0-9a-f]{32}$/);
    expect(collapse({}, 'Art')).toBe(base);
    expect(
      collapse({ additional_data: JSON.stringify({ category: 'Art' }) })
    ).toBe(base);
    expect(collapse({}, 'Music')).not.toBe(base);
    expect(collapse({ additional_identity_id: 'actor-2' })).not.toBe(base);
    expect(collapse({}, null)).toBeUndefined();
    expect(collapse({ additional_data: 'not json' })).toBeUndefined();
  });

  it('collapses NIC updates and follows per actor', () => {
    for (const cause of [
      IdentityNotificationCause.IDENTITY_NIC,
      IdentityNotificationCause.IDENTITY_SUBSCRIBED
    ]) {
      const collapse = (actor: string | null) =>
        getPushNotificationGrouping(
          source({ cause, wave_id: null, additional_identity_id: actor })
        ).collapseId;
      expect(collapse('actor-1')).toBe(collapse('actor-1'));
      expect(collapse('actor-1')).not.toBe(collapse('actor-2'));
      expect(collapse(null)).toBeUndefined();
    }
  });

  it('keeps only the latest subscription coverage status per profile', () => {
    const collapse = (identity_id: string) =>
      getPushNotificationGrouping(
        source({
          cause: IdentityNotificationCause.SUBSCRIPTION_COVERAGE,
          identity_id,
          wave_id: null,
          additional_identity_id: null,
          related_drop_id: null
        })
      ).collapseId;
    expect(collapse('recipient-1')).toBe(collapse('recipient-1'));
    expect(collapse('recipient-1')).not.toBe(collapse('recipient-2'));
  });

  it('keeps APNs keys bounded for any identifiers', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.values(IdentityNotificationCause)),
        fc.string({ minLength: 1, maxLength: 120 }),
        fc.option(fc.string({ maxLength: 120 })),
        fc.option(fc.string({ maxLength: 120 })),
        fc.option(fc.string({ maxLength: 120 })),
        fc.string({ maxLength: 120 }),
        (cause, identity, actor, drop, wave, category) => {
          const grouping = getPushNotificationGrouping({
            cause,
            identity_id: identity,
            additional_identity_id: actor,
            related_drop_id: drop,
            wave_id: wave,
            additional_data: { category }
          });
          expect(grouping.threadId).toMatch(/^(wave|profile):[0-9a-f]{32}$/);
          if (grouping.collapseId !== undefined) {
            expect(Buffer.byteLength(grouping.collapseId)).toBeLessThanOrEqual(
              APNS_COLLAPSE_ID_MAX_BYTES
            );
            expect(grouping.collapseId).toMatch(/^[a-z-]+:[0-9a-f]{32}$/);
          }
        }
      )
    );
  });
});
