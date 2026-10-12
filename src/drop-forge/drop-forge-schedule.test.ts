import fetch from 'node-fetch';
import { standardLaunchPlan } from '@/drop-forge/drop-forge.schedule';
import { testSource } from '@/drop-forge/drop-forge.test-fixtures';
import { buildLaunchPlan } from '@/drop-forge/drop-forge.plan';
import { testConfig } from '@/drop-forge/drop-forge.test-fixtures';
import { isResearchAirdrop } from '@/drop-forge/drop-forge.research';
jest.mock('node-fetch', () => ({ __esModule: true, default: jest.fn() }));
const source = {
  ...testSource,
  rows: [0, 1, 2].map((n) => ({ ...testSource.rows[0], phase: `Phase ${n}` }))
};
it.each(['2026-10-12T14:40:00Z', '2026-11-02T15:40:00Z'])(
  'derives the fixed phase gaps from the calendar instant %s',
  async (mint_start) => {
    const start = Date.parse(mint_start) / 1000;
    const end = start + 84000;
    jest.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        mint_number: 123,
        mint_start,
        mint_end: new Date(end * 1000).toISOString()
      })
    } as any);
    const plan = await standardLaunchPlan(123, source, start - 3600);
    expect(plan.initialize_at).toBe(start - 3600);
    expect(plan.phases.map((p) => [p.start, p.end])).toEqual([
      [start, start + 2400],
      [start + 3000, start + 4200],
      [start + 4800, start + 6000],
      [start + 6000, end]
    ]);
    const launch = buildLaunchPlan(
      testConfig,
      123,
      plan,
      source,
      start - 3600,
      true
    );
    expect(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Athens',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(new Date(launch.actions.find(isResearchAirdrop)!.due * 1000))
    ).toBe('17:15');
  }
);
it('rejects a calendar for another claim or a mint already started', async () => {
  const mint_start = '2026-10-12T14:40:00Z';
  const start = Date.parse(mint_start) / 1000;
  jest.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      mint_number: 124,
      mint_start,
      mint_end: '2026-10-13T15:00:00Z'
    })
  } as any);
  await expect(standardLaunchPlan(123, source, start - 1000)).rejects.toThrow(
    'future mint'
  );
  jest.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      mint_number: 123,
      mint_start,
      mint_end: '2026-10-13T15:00:00Z'
    })
  } as any);
  await expect(standardLaunchPlan(123, source, start)).rejects.toThrow(
    'future mint'
  );
});
