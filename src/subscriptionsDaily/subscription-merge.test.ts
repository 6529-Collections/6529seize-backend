import * as fc from 'fast-check';
import {
  mergeUpcomingSubscriptions,
  UpcomingSubscriptionState
} from './subscription-merge';

const at = (iso: string) => new Date(iso);

function row(
  overrides: Partial<UpcomingSubscriptionState>
): UpcomingSubscriptionState {
  return {
    subscribed: true,
    automatic_subscription: false,
    subscribed_count: 1,
    updated_at: at('2026-10-01T00:00:00Z'),
    ...overrides
  };
}

describe('mergeUpcomingSubscriptions', () => {
  it('keeps the larger count and the earlier priority when both are subscribed', () => {
    expect(
      mergeUpcomingSubscriptions(
        row({ subscribed_count: 2, updated_at: at('2026-10-05T00:00:00Z') }),
        row({ subscribed_count: 3, updated_at: at('2026-10-02T00:00:00Z') })
      )
    ).toEqual(
      row({ subscribed_count: 3, updated_at: at('2026-10-02T00:00:00Z') })
    );
  });

  it('subscribes the merged consolidation when only the merged row was subscribed', () => {
    expect(
      mergeUpcomingSubscriptions(
        row({ subscribed: false, subscribed_count: 5 }),
        row({
          subscribed_count: 2,
          automatic_subscription: true,
          updated_at: at('2026-10-03T00:00:00Z')
        })
      )
    ).toEqual(
      row({
        subscribed_count: 2,
        automatic_subscription: true,
        updated_at: at('2026-10-03T00:00:00Z')
      })
    );
  });

  it('lets a manual choice win over an automatic one', () => {
    expect(
      mergeUpcomingSubscriptions(
        row({ automatic_subscription: true }),
        row({ automatic_subscription: false })
      ).automatic_subscription
    ).toBe(false);
  });

  it('leaves the surviving row unchanged when neither is subscribed', () => {
    const surviving = row({ subscribed: false, subscribed_count: 4 });
    expect(
      mergeUpcomingSubscriptions(
        surviving,
        row({ subscribed: false, subscribed_count: 9 })
      )
    ).toBe(surviving);
  });

  it('never exceeds the larger subscribed count and never unsubscribes', () => {
    const state = fc.record({
      subscribed: fc.boolean(),
      automatic_subscription: fc.boolean(),
      subscribed_count: fc.integer({ min: 1, max: 20 }),
      updated_at: fc.date({
        min: at('2025-01-01T00:00:00Z'),
        max: at('2027-01-01T00:00:00Z')
      })
    });
    fc.assert(
      fc.property(state, state, (surviving, merged) => {
        const result = mergeUpcomingSubscriptions(surviving, merged);
        const subscribed = [surviving, merged].filter((it) => it.subscribed);
        expect(result.subscribed).toBe(subscribed.length > 0);
        if (subscribed.length > 0) {
          expect(result.subscribed_count).toBe(
            Math.max(...subscribed.map((it) => it.subscribed_count))
          );
          expect(subscribed.map((it) => it.updated_at.getTime())).toContain(
            result.updated_at.getTime()
          );
        }
      })
    );
  });
});
