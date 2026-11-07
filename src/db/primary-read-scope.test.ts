import { DbPoolName } from '@/db-query.options';
import { poolForUnboundQuery, withPrimaryReads } from '@/db/primary-read-scope';

describe('withPrimaryReads (waves 1.8)', () => {
  it('sends unbound reads to the primary only inside the scope', async () => {
    expect(poolForUnboundQuery(DbPoolName.READ)).toBe(DbPoolName.READ);

    const inside = await withPrimaryReads(async () => {
      await Promise.resolve();
      // Parallel branches keep the scope across awaits.
      return Promise.all([
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return poolForUnboundQuery(DbPoolName.READ);
        })(),
        (async () => poolForUnboundQuery(DbPoolName.READ))()
      ]);
    });

    expect(inside).toEqual([DbPoolName.WRITE, DbPoolName.WRITE]);
    expect(poolForUnboundQuery(DbPoolName.READ)).toBe(DbPoolName.READ);
  });

  it('leaves writes on the primary and does not leak into concurrent work', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const scoped = withPrimaryReads(async () => {
      await gate;
      return poolForUnboundQuery(DbPoolName.READ);
    });
    // Work started outside the scope while the scoped work is pending.
    const outside = (async () => {
      await Promise.resolve();
      return poolForUnboundQuery(DbPoolName.READ);
    })();

    expect(await outside).toBe(DbPoolName.READ);
    release();
    expect(await scoped).toBe(DbPoolName.WRITE);
    expect(poolForUnboundQuery(DbPoolName.WRITE)).toBe(DbPoolName.WRITE);
  });
});
