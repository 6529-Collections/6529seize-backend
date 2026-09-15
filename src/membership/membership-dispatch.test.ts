import { performance } from 'node:perf_hooks';
import { SqlExecutor } from '@/sql-executor';
import * as primary from './membership-primary';
import { MembershipDispatchCheckpointsDb } from './membership-dispatch-checkpoints.db';
import { MembershipDispatchDb } from './membership-dispatch.db';
import { MembershipRefreshDispatcher } from './membership-dispatch';
import { initialMembershipDispatchProgress } from './membership-dispatch-validation';
import { membershipDispatchTestOptions } from './membership-dispatch-test.helpers';
import {
  MembershipDispatchHint,
  MembershipDispatchPosition
} from './membership-dispatch.types';

const hint: MembershipDispatchHint = {
  target: { scope: 'PROFILE', target_id: 'm5-unit' },
  delivery: { requested_version: '1', reserved_until_millis: '1000' }
};
const key: MembershipDispatchPosition = {
  lane: 'DUE',
  key: hint.target,
  exhausted: false
};
const db = {} as SqlExecutor;

describe('membership external dispatcher orchestration', () => {
  beforeEach(() => {
    jest
      .spyOn(primary, 'withMembershipPrimaryTransaction')
      .mockImplementation(async (_db, callback) =>
        callback({} as primary.MembershipPrimaryContext)
      );
  });
  afterEach(() => jest.restoreAllMocks());

  it('finishes each reservation and send before reserving the next durable position', async () => {
    const events: string[] = [];
    let position = 0;
    jest
      .spyOn(MembershipDispatchCheckpointsDb.prototype, 'reserve')
      .mockImplementation(async () => {
        events.push('control');
        return {
          ...key,
          key: { ...hint.target, target_id: `m5-unit-${++position}` }
        };
      });
    jest
      .spyOn(MembershipDispatchDb.prototype, 'reserve')
      .mockImplementation(async (target) => {
        events.push('target');
        return {
          outcome: 'RESERVED',
          hint: {
            ...hint,
            target: { scope: 'PROFILE', target_id: target.target_id }
          },
          observed_due_age_millis: 3
        };
      });
    const send = jest.fn(async () => {
      events.push('send');
    });
    const result = await new MembershipRefreshDispatcher(db, send).run(
      membershipDispatchTestOptions({ max_candidates: 2 })
    );
    expect(events).toEqual([
      'control',
      'target',
      'send',
      'control',
      'target',
      'send'
    ]);
    expect(result).toMatchObject({ sent: 2, oldest_due_age_millis: 3 });
  });
  it('advances duplicate raw positions but reserves a canonical target only once per invocation', async () => {
    const positions = jest
      .spyOn(MembershipDispatchCheckpointsDb.prototype, 'reserve')
      .mockResolvedValueOnce(key)
      .mockResolvedValueOnce({ ...key, lane: 'TARGET_PK' });
    const reserve = jest
      .spyOn(MembershipDispatchDb.prototype, 'reserve')
      .mockResolvedValue({
        outcome: 'RESERVED',
        hint,
        observed_due_age_millis: 0
      });
    const send = jest.fn(async () => undefined);
    const dispatcher = new MembershipRefreshDispatcher(db, send);
    const result = await dispatcher.run(
      membershipDispatchTestOptions({ max_candidates: 2 })
    );
    expect(positions).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      raw_candidates: 2,
      due_candidates: 1,
      target_pk_candidates: 1,
      sent: 1,
      skipped: 1,
      outcomes: { SENT: 1, DUPLICATE_TARGET: 1 }
    });
    positions.mockResolvedValue(key);
    await dispatcher.run(membershipDispatchTestOptions({ max_candidates: 1 }));
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it.each([1, 2])(
    'performs no dependent action after an UNKNOWN phase %s commit',
    async (phase) => {
      let transactions = 0;
      jest
        .spyOn(primary, 'withMembershipPrimaryTransaction')
        .mockImplementation(async (_db, callback) => {
          const result = await callback({} as primary.MembershipPrimaryContext);
          if (++transactions === phase)
            throw { commitOutcome: 'UNKNOWN', code: 'ER_LOCK_NOWAIT' };
          return result;
        });
      jest
        .spyOn(MembershipDispatchCheckpointsDb.prototype, 'reserve')
        .mockResolvedValue(key);
      const target = jest
        .spyOn(MembershipDispatchDb.prototype, 'reserve')
        .mockResolvedValue({
          outcome: 'RESERVED',
          hint,
          observed_due_age_millis: 0
        });
      const send = jest.fn();
      await expect(
        new MembershipRefreshDispatcher(db, send).run(
          membershipDispatchTestOptions()
        )
      ).rejects.toMatchObject({ commitOutcome: 'UNKNOWN' });
      expect(target).toHaveBeenCalledTimes(phase - 1);
      expect(send).not.toHaveBeenCalled();
    }
  );
  it('aborts a sender that fails to settle, counts ambiguity and leaves its reservation', async () => {
    jest
      .spyOn(MembershipDispatchCheckpointsDb.prototype, 'reserve')
      .mockResolvedValue(key);
    const reserve = jest
      .spyOn(MembershipDispatchDb.prototype, 'reserve')
      .mockResolvedValue({
        outcome: 'RESERVED',
        hint,
        observed_due_age_millis: 0
      });
    let signal: AbortSignal | undefined;
    const send = jest.fn((_hint, budget) => {
      signal = budget.signal;
      return new Promise<void>(() => {});
    });
    const result = await new MembershipRefreshDispatcher(db, send).run(
      membershipDispatchTestOptions({ max_candidates: 1, send_millis: 10 })
    );
    expect(result).toMatchObject({ sent: 0, send_failed: 1 });
    expect(signal?.aborted).toBe(true);
    expect(reserve).toHaveBeenCalledTimes(1);
  });
  it('refuses a quantum without a full control, target, send and cleanup allowance', async () => {
    const control = jest.spyOn(
      MembershipDispatchCheckpointsDb.prototype,
      'reserve'
    );
    const result = await new MembershipRefreshDispatcher(db, jest.fn()).run(
      membershipDispatchTestOptions({
        deadline_monotonic_millis: performance.now() + 100
      })
    );
    expect(result.budget_exhausted).toBe(true);
    expect(control).not.toHaveBeenCalled();
  });
  it('closes empty lanes after one wrap and retains the hard total and lane ceilings', async () => {
    let progress = initialMembershipDispatchProgress();
    const turns: string[] = [];
    jest
      .spyOn(MembershipDispatchCheckpointsDb.prototype, 'reserve')
      .mockImplementation(async (closed) => {
        const lane = progress.next_lane;
        progress = {
          ...progress,
          next_lane: lane === 'DUE' ? 'TARGET_PK' : 'DUE'
        };
        turns.push(lane);
        if (lane === 'DUE') {
          if (turns.length > 1) expect(closed).toContain('DUE');
          return { lane, key: null, exhausted: true };
        }
        return {
          lane,
          key: { ...hint.target, target_id: `m5-unit-${turns.length}` },
          exhausted: false
        };
      });
    jest
      .spyOn(MembershipDispatchDb.prototype, 'reserve')
      .mockResolvedValue({ outcome: 'PARKED', observed_due_age_millis: 0 });
    const result = await new MembershipRefreshDispatcher(db, jest.fn()).run(
      membershipDispatchTestOptions()
    );
    expect(turns).toHaveLength(40);
    expect(result).toMatchObject({
      due_candidates: 0,
      target_pk_candidates: 20,
      parked_seen: 20,
      sent: 0
    });
  });
});
