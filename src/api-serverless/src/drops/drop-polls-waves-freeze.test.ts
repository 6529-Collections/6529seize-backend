import { DropPollsApiService } from '@/api/drops/drop-polls.api.service';
import { AuthenticationContext } from '@/auth-context';
import { DropType } from '@/entities/IDrop';
import { Time } from '@/time';
import { WavesFrozenException } from '@/waves-freeze/waves-freeze';
import { stubWavesScope } from '@/tests/fixtures/waves-scope.fixture';

const FLAG = 'FEATURE_WAVES_FROZEN';
const AT = 'WAVES_FREEZE_AT';
const FREEZE = Date.UTC(2026, 10, 25);
const LATER = Date.UTC(2027, 0, 1);

function createService() {
  const dropPollsDb = {
    createPoll: jest.fn(),
    executeNativeQueriesInTransaction: jest.fn(
      (work: (connection: unknown) => Promise<unknown>) => work({})
    ),
    findPollByDropIdForUpdate: jest.fn(),
    findOptionsByPollId: jest.fn().mockResolvedValue([{ option_no: 1 }]),
    replaceVoterVotes: jest.fn()
  };
  const wavesApiDb = { findById: jest.fn() };
  const dropsDb = {
    findDropByIdWithEligibilityCheck: jest
      .fn()
      .mockRejectedValue(new Error('past the waves freeze check'))
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
    {} as any,
    {} as any,
    {} as any
  );
  return { service, dropPollsDb, dropsDb, wavesApiDb };
}

/** The freeze time passes during the next call of `stub`. */
function freezeStartsOn(stub: jest.Mock, result: unknown) {
  process.env[AT] = new Date(FREEZE).toISOString();
  const now = jest.spyOn(Time, 'currentMillis').mockReturnValue(FREEZE - 1);
  stub.mockImplementation(async () => {
    now.mockReturnValue(FREEZE + 1);
    return result;
  });
}

const ctx = {
  authenticationContext: new AuthenticationContext({
    authenticatedWallet: '0x1111111111111111111111111111111111111111',
    authenticatedProfileId: 'voter',
    roleProfileId: null,
    activeProxyActions: []
  })
};

// Every wave moves unless a test says otherwise.
beforeEach(() => {
  stubWavesScope();
});

describe('polls during the waves freeze', () => {
  const original: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const name of [FLAG, AT]) original[name] = process.env[name];
  });
  beforeEach(() => {
    for (const name of [FLAG, AT]) delete process.env[name];
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(() => {
    for (const name of [FLAG, AT]) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  it('makes no poll while frozen', async () => {
    process.env[FLAG] = 'true';
    const { service, dropPollsDb } = createService();
    await expect(
      service.createPollForDrop(
        {
          poll: {
            title: 'Which one?',
            options: ['a', 'b'],
            closing_time: null,
            multichoice: false,
            anonymous: false,
            only_droppers_can_respond: false
          } as any,
          dropId: 'drop',
          waveId: 'wave',
          authorId: 'author',
          dropType: DropType.CHAT
        },
        ctx
      )
    ).rejects.toBeInstanceOf(WavesFrozenException);
    expect(dropPollsDb.createPoll).not.toHaveBeenCalled();
  });

  it('still posts a drop with no poll while frozen', async () => {
    process.env[FLAG] = 'true';
    const { service } = createService();
    await expect(
      service.createPollForDrop(
        {
          poll: null,
          dropId: 'drop',
          waveId: 'wave',
          authorId: 'author',
          dropType: DropType.CHAT
        },
        ctx
      )
    ).resolves.toBeUndefined();
  });

  it("takes no poll vote in a moving wave while frozen, but takes a staying wave's", async () => {
    process.env[FLAG] = 'true';
    stubWavesScope({ staying: ['staying-wave'] });
    const { service, dropsDb, wavesApiDb } = createService();
    // Read the drop, which names its wave; refused before the wave is read.
    dropsDb.findDropByIdWithEligibilityCheck.mockResolvedValue({
      id: 'drop',
      wave_id: 'moving-wave'
    });
    await expect(
      service.vote({ dropId: 'drop', voterId: 'voter', options: [1] }, ctx)
    ).rejects.toBeInstanceOf(WavesFrozenException);
    expect(wavesApiDb.findById).not.toHaveBeenCalled();

    dropsDb.findDropByIdWithEligibilityCheck.mockResolvedValue({
      id: 'drop',
      wave_id: 'staying-wave'
    });
    wavesApiDb.findById.mockRejectedValue(
      new Error('past the waves freeze check')
    );
    await expect(
      service.vote({ dropId: 'drop', voterId: 'voter', options: [1] }, ctx)
    ).rejects.toThrow('past the waves freeze check');
  });

  it('takes poll votes as before when not frozen', async () => {
    delete process.env[FLAG];
    const { service } = createService();
    await expect(
      service.vote({ dropId: 'drop', voterId: 'voter', options: [1] }, ctx)
    ).rejects.toThrow('past the waves freeze check');
  });

  it('makes no poll when the freeze starts after the early check', async () => {
    const { service, dropPollsDb, wavesApiDb } = createService();
    freezeStartsOn(wavesApiDb.findById, {
      created_by: 'author',
      admin_group_id: null,
      chat_enabled: true
    });
    await expect(
      service.createPollForDrop(
        {
          poll: {
            title: 'Which one?',
            options: ['a', 'b'],
            closing_time: LATER,
            multichoice: false,
            anonymous: false,
            only_droppers_can_respond: false
          } as any,
          dropId: 'drop',
          waveId: 'wave',
          authorId: 'author',
          dropType: DropType.CHAT
        },
        ctx
      )
    ).rejects.toBeInstanceOf(WavesFrozenException);
    expect(wavesApiDb.findById).toHaveBeenCalledTimes(1);
    expect(dropPollsDb.createPoll).not.toHaveBeenCalled();
  });

  it('takes no poll vote when the poll lock wait passes the freeze', async () => {
    const { service, dropPollsDb, wavesApiDb } = createService();
    jest
      .spyOn(service as any, 'findVisibleDropOrThrow')
      .mockResolvedValue({ id: 'drop', wave_id: 'wave', author_id: 'author' });
    jest
      .spyOn(service as any, 'assertPollRespondentCanVote')
      .mockResolvedValue(undefined);
    wavesApiDb.findById.mockResolvedValue({ id: 'wave' });
    freezeStartsOn(dropPollsDb.findPollByDropIdForUpdate, {
      id: 'poll',
      closing_time: LATER,
      multichoice: false,
      anonymous: false
    });
    await expect(
      service.vote({ dropId: 'drop', voterId: 'voter', options: [1] }, ctx)
    ).rejects.toBeInstanceOf(WavesFrozenException);
    expect(dropPollsDb.findPollByDropIdForUpdate).toHaveBeenCalledTimes(1);
    expect(dropPollsDb.replaceVoterVotes).not.toHaveBeenCalled();
  });
});
