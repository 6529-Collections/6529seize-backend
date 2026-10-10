import * as fc from 'fast-check';
import {
  planConsolidationEvent,
  planConsolidationRewind
} from './consolidation-row-plan';
import {
  Consolidation,
  ConsolidationEvent,
  EventType
} from './entities/IDelegation';

const A = '0xAaaa000000000000000000000000000000000001';
const B = '0xBbbb000000000000000000000000000000000002';

function row(
  wallet1: string,
  wallet2: string,
  {
    block,
    confirmed,
    wallet1RegisteredAt = null,
    wallet2RegisteredAt = null
  }: {
    block: number;
    confirmed: boolean;
    wallet1RegisteredAt?: number | null;
    wallet2RegisteredAt?: number | null;
  }
): Consolidation {
  return Object.assign(new Consolidation(), {
    wallet1,
    wallet2,
    block,
    confirmed,
    wallet1_registered_at: wallet1RegisteredAt,
    wallet2_registered_at: wallet2RegisteredAt
  });
}

function event(
  type: EventType,
  wallet1: string,
  wallet2: string,
  block: number,
  timestamp?: number
): ConsolidationEvent {
  return { type, wallet1, wallet2, block, timestamp };
}

const key = (w1: string, w2: string) => `${w1}|${w2}`;

// Applies events the way persistConsolidations does, against an in-memory
// table keyed by the (wallet1, wallet2) primary key.
function applyEvents(
  events: ConsolidationEvent[],
  table = new Map<string, Consolidation>()
): Consolidation[] {
  for (const e of events) {
    const sameDirection = table.get(key(e.wallet1, e.wallet2)) ?? null;
    const reverseDirection = sameDirection
      ? null
      : (table.get(key(e.wallet2, e.wallet1)) ?? null);
    const plan = planConsolidationEvent(e, sameDirection, reverseDirection);
    plan.remove.forEach((r) => table.delete(key(r.wallet1, r.wallet2)));
    plan.save.forEach((r) => table.set(key(r.wallet1, r.wallet2), r));
  }
  return Array.from(table.values());
}

describe('planConsolidationEvent', () => {
  it('stores a first registration as an unconfirmed one-way link', () => {
    expect(applyEvents([event(EventType.REGISTER, A, B, 10, 1000)])).toEqual([
      row(A, B, { block: 10, confirmed: false, wallet1RegisteredAt: 1000 })
    ]);
  });

  it('confirms the link when the other wallet registers back', () => {
    expect(
      applyEvents([
        event(EventType.REGISTER, A, B, 10, 1000),
        event(EventType.REGISTER, B, A, 12, 1200)
      ])
    ).toEqual([
      row(A, B, {
        block: 12,
        confirmed: true,
        wallet1RegisteredAt: 1000,
        wallet2RegisteredAt: 1200
      })
    ]);
  });

  it('refreshes only the registration time when the first registrant registers again', () => {
    expect(
      applyEvents([
        event(EventType.REGISTER, A, B, 10, 1000),
        event(EventType.REGISTER, B, A, 12, 1200),
        event(EventType.REGISTER, A, B, 20, 2000)
      ])
    ).toEqual([
      row(A, B, {
        block: 12,
        confirmed: true,
        wallet1RegisteredAt: 2000,
        wallet2RegisteredAt: 1200
      })
    ]);
  });

  it('keeps stamping the block when the second registrant registers again', () => {
    expect(
      applyEvents([
        event(EventType.REGISTER, A, B, 10, 1000),
        event(EventType.REGISTER, B, A, 12, 1200),
        event(EventType.REGISTER, B, A, 20, 2000)
      ])
    ).toEqual([
      row(A, B, {
        block: 20,
        confirmed: true,
        wallet1RegisteredAt: 1000,
        wallet2RegisteredAt: 2000
      })
    ]);
  });

  it('keeps the other direction and its time when either wallet revokes', () => {
    const confirmed = [
      event(EventType.REGISTER, A, B, 10, 1000),
      event(EventType.REGISTER, B, A, 12, 1200)
    ];
    expect(
      applyEvents([...confirmed, event(EventType.REVOKE, A, B, 30, 3000)])
    ).toEqual([
      row(B, A, { block: 30, confirmed: false, wallet1RegisteredAt: 1200 })
    ]);
    expect(
      applyEvents([...confirmed, event(EventType.REVOKE, B, A, 30, 3000)])
    ).toEqual([
      row(A, B, { block: 30, confirmed: false, wallet1RegisteredAt: 1000 })
    ]);
  });

  it('removes a one-way link when its registrant revokes', () => {
    expect(
      applyEvents([
        event(EventType.REGISTER, A, B, 10, 1000),
        event(EventType.REVOKE, A, B, 11, 1100)
      ])
    ).toEqual([]);
  });

  it('leaves the registered direction in place when the other wallet revokes a link it never made', () => {
    expect(
      applyEvents([
        event(EventType.REGISTER, A, B, 10, 1000),
        event(EventType.REVOKE, B, A, 11, 1100)
      ])
    ).toEqual([
      row(A, B, { block: 11, confirmed: false, wallet1RegisteredAt: 1000 })
    ]);
  });

  it('ignores a revoke when no link exists', () => {
    expect(applyEvents([event(EventType.REVOKE, A, B, 11, 1100)])).toEqual([]);
  });

  it('keeps legacy links without times as unknown', () => {
    const legacyConfirmed = row(A, B, { block: 5, confirmed: true });
    const plan = planConsolidationEvent(
      event(EventType.REVOKE, A, B, 30, 3000),
      legacyConfirmed,
      null
    );
    expect(plan.save).toEqual([
      row(B, A, { block: 30, confirmed: false, wallet1RegisteredAt: null })
    ]);
    expect(
      planConsolidationEvent(
        event(EventType.REGISTER, A, B, 31),
        legacyConfirmed,
        null
      )
    ).toEqual({ remove: [], save: [] });
  });

  it('always matches the registrations that are currently live', () => {
    const anEvent = fc.record({
      type: fc.constantFrom(EventType.REGISTER, EventType.REVOKE),
      fromA: fc.boolean()
    });
    fc.assert(
      fc.property(fc.array(anEvent, { maxLength: 30 }), (steps) => {
        // Model: which directions are registered, and when each last was.
        const live = new Map<string, number>();
        const events = steps.map(({ type, fromA }, index) => {
          const [from, to] = fromA ? [A, B] : [B, A];
          const timestamp = 1000 + index;
          if (type === EventType.REGISTER) {
            live.set(from, timestamp);
          } else {
            live.delete(from);
          }
          return event(type, from, to, 100 + index, timestamp);
        });

        const rows = applyEvents(events);
        expect(rows.length).toBe(live.size === 0 ? 0 : 1);
        if (rows.length === 0) {
          return;
        }
        const [stored] = rows;
        expect(stored.confirmed).toBe(live.size === 2);
        expect(stored.wallet1_registered_at).toBe(live.get(stored.wallet1));
        if (stored.confirmed) {
          expect(stored.wallet2_registered_at).toBe(live.get(stored.wallet2));
        } else {
          expect(live.has(stored.wallet1)).toBe(true);
          expect(stored.wallet2_registered_at).toBeNull();
        }
      }),
      { numRuns: 1000 }
    );
  });
});

describe('planConsolidationRewind', () => {
  const confirmed = (block: number, at1: number | null, at2: number | null) =>
    row(A, B, {
      block,
      confirmed: true,
      wallet1RegisteredAt: at1,
      wallet2RegisteredAt: at2
    });

  it('keeps a row whose directions were registered before the reset time', () => {
    expect(planConsolidationRewind(confirmed(50, 1000, 1100), 1200)).toEqual({
      remove: [],
      save: []
    });
  });

  it('drops a direction registered at or after the reset time', () => {
    const stored = confirmed(50, 1000, 1200);
    expect(planConsolidationRewind(stored, 1200)).toEqual({
      remove: [stored],
      save: [
        row(A, B, { block: 50, confirmed: false, wallet1RegisteredAt: 1000 })
      ]
    });
  });

  it('keeps the second direction as a one-way row when only the first is dropped', () => {
    const stored = confirmed(50, 1300, 1100);
    expect(planConsolidationRewind(stored, 1200)).toEqual({
      remove: [stored],
      save: [
        row(B, A, { block: 50, confirmed: false, wallet1RegisteredAt: 1100 })
      ]
    });
  });

  it('removes a row whose directions were all registered after the reset time', () => {
    const stored = confirmed(50, 1300, 1400);
    expect(planConsolidationRewind(stored, 1200)).toEqual({
      remove: [stored],
      save: []
    });
  });

  it('keeps directions registered before times were tracked', () => {
    expect(planConsolidationRewind(confirmed(50, null, null), 1200)).toEqual({
      remove: [],
      save: []
    });
  });

  it('gives the full-history links and times when the events from any reset block are replayed', () => {
    const wallets = [A, B, '0xCccc000000000000000000000000000000000003'];
    const anEvent = fc.record({
      type: fc.constantFrom(EventType.REGISTER, EventType.REVOKE),
      from: fc.constantFrom(0, 1, 2),
      to: fc.constantFrom(0, 1, 2)
    });
    // Live directions and each wallet's latest registration time. A pair's
    // block can move later than in a full replay when a direction that
    // predates the reset block was registered again after it, because the
    // replay orders that pair by the later registration.
    const snapshot = (rows: Consolidation[]) =>
      rows
        .flatMap((it) => [
          `${it.wallet1}>${it.wallet2}@${it.wallet1_registered_at}`,
          ...(it.confirmed
            ? [`${it.wallet2}>${it.wallet1}@${it.wallet2_registered_at}`]
            : [])
        ])
        .sort((x, y) => x.localeCompare(y));
    fc.assert(
      fc.property(
        fc.array(anEvent, { maxLength: 40 }),
        fc.nat(),
        (steps, resetSeed) => {
          const events = steps
            .filter(({ from, to }) => from !== to)
            .map(({ type, from, to }, index) =>
              event(
                type,
                wallets[from],
                wallets[to],
                index + 1,
                (index + 1) * 12
              )
            );
          const resetBlock = (resetSeed % (events.length + 1)) + 1;
          const full = applyEvents(events);

          const table = new Map<string, Consolidation>();
          for (const stored of full) {
            table.set(key(stored.wallet1, stored.wallet2), stored);
          }
          for (const stored of full.filter((it) => it.block >= resetBlock)) {
            const plan = planConsolidationRewind(stored, resetBlock * 12);
            plan.remove.forEach((r) => table.delete(key(r.wallet1, r.wallet2)));
            plan.save.forEach((r) => table.set(key(r.wallet1, r.wallet2), r));
          }
          const replayed = applyEvents(
            events.filter((it) => it.block >= resetBlock),
            table
          );

          expect(snapshot(replayed)).toEqual(snapshot(full));
        }
      ),
      { numRuns: 2000 }
    );
  });
});
