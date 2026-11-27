import { DROPS_TABLE } from '@/constants';
import { PageSortDirection } from '@/api/page-request';
import { DropPollsDb, DropPollsOrderBy, DropPollState } from './drop-polls.db';

const FREEZE = Date.UTC(2026, 10, 27);
const NOW = Date.UTC(2026, 10, 29);
const CLOSING =
  '(case when p.closing_time > :closesAt and (d.created_at is null or d.created_at <= :closesAt) then :closesAt else p.closing_time end)';

function createDb() {
  const execute = jest.fn().mockResolvedValue([]);
  const oneOrNull = jest.fn().mockResolvedValue({ cnt: '0' });
  const service = new DropPollsDb(() => ({ execute, oneOrNull }) as any);
  return { service, execute, oneOrNull };
}

describe('DropPollsDb: a moved wave closes its polls at the freeze', () => {
  it("lists polls by the wave's close time: the Open and Closed filters and the sort", async () => {
    const { service, execute } = createDb();
    for (const [state, filter] of [
      [DropPollState.OPEN, `and ${CLOSING} > :now`],
      [DropPollState.CLOSED, `and ${CLOSING} <= :now`]
    ] as const) {
      execute.mockClear();
      await service.findWavePolls(
        {
          waveId: 'wave-1',
          limit: 10,
          offset: 0,
          order: PageSortDirection.ASC,
          orderBy: DropPollsOrderBy.CLOSING_TIME,
          state,
          now: NOW,
          closesAt: FREEZE
        },
        {}
      );
      const [sql, params] = execute.mock.calls[0];
      expect(sql).toContain(filter);
      expect(sql).toContain(`order by ${CLOSING} ASC, p.id ASC`);
      expect(sql).toContain(`join ${DROPS_TABLE} d on d.id = p.drop_id`);
      expect(params).toEqual({
        waveId: 'wave-1',
        now: NOW,
        limit: 10,
        offset: 0,
        closesAt: FREEZE
      });
    }
  });

  it('counts polls and open unanswered polls by the close time, with their drops', async () => {
    const { service, oneOrNull } = createDb();
    await service.countWavePolls(
      {
        waveId: 'wave-1',
        state: DropPollState.OPEN,
        now: NOW,
        closesAt: FREEZE
      },
      {}
    );
    await service.countOpenUnansweredWavePolls(
      { waveId: 'wave-1', now: NOW, closesAt: FREEZE },
      {}
    );
    for (const [sql, params] of oneOrNull.mock.calls) {
      expect(sql).toContain(`left join ${DROPS_TABLE} d on d.id = p.drop_id`);
      expect(sql).toContain(`and ${CLOSING} > :now`);
      expect(params).toMatchObject({ closesAt: FREEZE, now: NOW });
    }
  });

  it('reads as before with no close time: no drop join, no extra parameter', async () => {
    const { service, oneOrNull } = createDb();
    await service.countWavePolls(
      { waveId: 'wave-1', state: DropPollState.OPEN, now: NOW, closesAt: null },
      {}
    );
    await service.countOpenUnansweredWavePolls(
      { waveId: 'wave-1', now: NOW },
      {}
    );
    for (const [sql, params] of oneOrNull.mock.calls) {
      expect(sql).not.toContain(DROPS_TABLE);
      expect(sql).toContain('and p.closing_time > :now');
      expect(params).not.toHaveProperty('closesAt');
    }
  });

  it("gives each poll its drop's created_at, so a moved wave can tell what was made before the freeze", async () => {
    const { service, execute } = createDb();
    const row = {
      id: 'poll-1',
      wave_id: 'wave-1',
      drop_id: 'drop-1',
      closing_time: String(NOW),
      multichoice: 0,
      anonymous: 0,
      only_droppers_can_respond: 0,
      option_no: 1,
      option_string: 'First',
      votes: '1',
      voted_by_context_profile: 0
    };
    execute.mockResolvedValueOnce([
      { ...row, created_at: String(FREEZE - 1) },
      { ...row, drop_id: 'drop-2', id: 'poll-2', created_at: null }
    ]);
    const polls = await service.findPollsByDropIds(['drop-1', 'drop-2'], {});
    expect(polls['drop-1'].created_at).toBe(FREEZE - 1);
    expect(polls['drop-2']).not.toHaveProperty('created_at');
    const [sql] = execute.mock.calls[0];
    expect(sql).toContain(`left join ${DROPS_TABLE} d on d.id = p.drop_id`);
    expect(sql).toContain('d.created_at,');
  });
});
