import { AuthenticationContext } from '@/auth-context';
import { DropPollsApiService } from '@/api/drops/drop-polls.api.service';
import { DropPollState, DropPollsOrderBy } from '@/api/drops/drop-polls.db';
import { PageSortDirection } from '@/api/page-request';
import { Time } from '@/time';
import { WavesFrozenException } from '@/waves-freeze/waves-freeze';
import { WavesPollClosedAtMoveException } from '@/waves-freeze/waves-moved-polls';
import { stubWavesScope } from '@/tests/fixtures/waves-scope.fixture';

const NAMES = [
  'FEATURE_WAVES_FROZEN',
  'WAVES_FREEZE_AT',
  'FEATURE_WAVES_ON_CHAIN',
  'WAVES_SWITCH_ON_AT'
];
const FREEZE = Date.UTC(2026, 10, 27);
const SWITCH_ON = Date.UTC(2026, 10, 28);
const LATER = Date.UTC(2026, 11, 5);
const PAST_THE_CHECKS = new Error('past the move checks');

function createService(drop: {
  id: string;
  wave_id: string;
  created_at: number;
}) {
  const dropPollsDb = {
    findPollsByDropIds: jest.fn(),
    countWavePolls: jest.fn().mockResolvedValue(0),
    countOpenUnansweredWavePolls: jest.fn().mockResolvedValue(0),
    findWavePolls: jest.fn().mockResolvedValue([]),
    executeNativeQueriesInTransaction: jest.fn(),
    replaceVoterVotes: jest.fn()
  };
  const dropsDb = {
    findDropByIdWithEligibilityCheck: jest.fn().mockResolvedValue(drop)
  };
  const wavesApiDb = {
    // The vote goes on to read the wave once the move checks pass.
    findById: jest.fn().mockRejectedValue(PAST_THE_CHECKS),
    findWaveById: jest.fn().mockResolvedValue({
      id: drop.wave_id,
      parent_wave_id: null,
      visibility_group_id: null
    })
  };
  const userGroupsService = {
    getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
  };
  const service = new DropPollsApiService(
    dropPollsDb as any,
    dropsDb as any,
    wavesApiDb as any,
    userGroupsService as any,
    {} as any,
    { findDropsV2ByIds: jest.fn().mockResolvedValue({}) } as any,
    {} as any,
    {} as any
  );
  return { service, dropPollsDb };
}

const voteCtx = {
  authenticationContext: AuthenticationContext.fromProfileId('voter-1')
};

function vote(service: DropPollsApiService, dropId: string) {
  return service.vote({ dropId, voterId: 'voter-1', options: [1] }, voteCtx);
}

describe('a poll still open at the freeze, from the switch-on', () => {
  const original: Record<string, string | undefined> = {};
  let now: jest.SpyInstance;
  beforeAll(() => {
    for (const name of NAMES) original[name] = process.env[name];
  });
  beforeEach(() => {
    for (const name of NAMES) delete process.env[name];
    process.env.WAVES_FREEZE_AT = new Date(FREEZE).toISOString();
    process.env.WAVES_SWITCH_ON_AT = new Date(SWITCH_ON).toISOString();
    now = jest.spyOn(Time, 'currentMillis').mockReturnValue(SWITCH_ON + 1);
    // Every wave moves unless a test says otherwise.
    stubWavesScope({ staying: ['staying-wave'] });
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(() => {
    for (const name of NAMES) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  const imported = (waveId: string) => ({
    id: 'drop-1',
    wave_id: waveId,
    created_at: FREEZE - 60_000
  });
  const pollClosing = (closingTime: number) => ({
    'drop-1': { id: 'poll-1', wave_id: 'w', closing_time: closingTime }
  });

  describe('the vote path', () => {
    it("refuses a ballot plainly, before the freeze's own refusal", async () => {
      const { service, dropPollsDb } = createService(imported('moved-wave'));
      dropPollsDb.findPollsByDropIds.mockResolvedValue(pollClosing(LATER));
      await expect(vote(service, 'drop-1')).rejects.toBeInstanceOf(
        WavesPollClosedAtMoveException
      );
      expect(dropPollsDb.findPollsByDropIds).toHaveBeenCalledWith(
        ['drop-1'],
        voteCtx
      );
      expect(dropPollsDb.replaceVoterVotes).not.toHaveBeenCalled();
    });

    it("leaves a staying wave's poll to the usual checks", async () => {
      const { service, dropPollsDb } = createService(imported('staying-wave'));
      dropPollsDb.findPollsByDropIds.mockResolvedValue(pollClosing(LATER));
      await expect(vote(service, 'drop-1')).rejects.toBe(PAST_THE_CHECKS);
    });

    it('leaves a poll that closed before the freeze to the freeze', async () => {
      const { service, dropPollsDb } = createService(imported('moved-wave'));
      dropPollsDb.findPollsByDropIds.mockResolvedValue(pollClosing(FREEZE - 1));
      await expect(vote(service, 'drop-1')).rejects.toBeInstanceOf(
        WavesFrozenException
      );
    });

    it('reads no poll for a drop made after the freeze, or before the switch-on', async () => {
      const later = createService({
        ...imported('moved-wave'),
        created_at: FREEZE + 1
      });
      await expect(vote(later.service, 'drop-1')).rejects.toBeInstanceOf(
        WavesFrozenException
      );
      expect(later.dropPollsDb.findPollsByDropIds).not.toHaveBeenCalled();

      now.mockReturnValue(SWITCH_ON - 1);
      const before = createService(imported('moved-wave'));
      await expect(vote(before.service, 'drop-1')).rejects.toBeInstanceOf(
        WavesFrozenException
      );
      expect(before.dropPollsDb.findPollsByDropIds).not.toHaveBeenCalled();
    });
  });

  describe('the Polls tab', () => {
    const list = (service: DropPollsApiService, waveId: string) =>
      service.findWavePolls(
        {
          wave_id: waveId,
          page: 1,
          page_size: 20,
          sort_direction: PageSortDirection.DESC,
          sort: DropPollsOrderBy.CLOSING_TIME,
          state: DropPollState.OPEN
        },
        {}
      );

    it("counts, filters and sorts a moved wave's polls by the freeze", async () => {
      const { service, dropPollsDb } = createService(imported('moved-wave'));
      await list(service, 'moved-wave');
      for (const read of [
        dropPollsDb.countWavePolls,
        dropPollsDb.countOpenUnansweredWavePolls,
        dropPollsDb.findWavePolls
      ]) {
        expect(read.mock.calls[0][0]).toMatchObject({
          waveId: 'moved-wave',
          closesAt: FREEZE
        });
      }
    });

    it("reads a staying wave's polls, and every wave's before the switch-on, as before", async () => {
      const staying = createService(imported('staying-wave'));
      await list(staying.service, 'staying-wave');
      now.mockReturnValue(SWITCH_ON - 1);
      const before = createService(imported('moved-wave'));
      await list(before.service, 'moved-wave');
      for (const { dropPollsDb } of [staying, before]) {
        for (const read of [
          dropPollsDb.countWavePolls,
          dropPollsDb.countOpenUnansweredWavePolls,
          dropPollsDb.findWavePolls
        ]) {
          expect(read.mock.calls[0][0]).not.toHaveProperty('closesAt');
        }
      }
    });
  });
});
