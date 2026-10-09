import { compareLegacyFacade } from './legacy-competition-facade-parity';
import { SqlExecutor } from '@/sql-executor';

jest.mock('./legacy-competition-get-facade', () => ({
  ...jest.requireActual('./legacy-competition-get-facade'),
  withLegacyShadowGetFacade: (
    _db: SqlExecutor,
    _id: string,
    _ctx: object,
    action: () => Promise<unknown>
  ) => action()
}));

describe('complete legacy relation comparison', () => {
  it.each([false, true])(
    'compares rows beyond 10,000 and detects a tail mismatch: %s',
    async (corrupt) => {
      const rows = Array.from({ length: 13_583 }, (_, index) => ({
        wave_id: 'wave',
        decision_time: index
      }));
      const execute = jest.fn(async (sql: string) => {
        expect(sql).not.toMatch(/\blimit\b/i);
        if (!sql.includes('wave_decisions')) return [];
        if (corrupt && sql.includes('legacy_get_'))
          return [...rows.slice(0, -1), { ...rows.at(-1), decision_time: -1 }];
        return rows;
      });
      const db = { execute } as unknown as SqlExecutor;
      const categories = await compareLegacyFacade(
        db,
        'competition',
        'wave',
        {}
      );
      const decisions = categories.find(
        (category) => category.category === 'frozen_relation:wave_decisions'
      );
      expect(decisions).toBeDefined();
      expect(decisions?.baselineHash === decisions?.candidateHash).toBe(
        !corrupt
      );
    }
  );
});
