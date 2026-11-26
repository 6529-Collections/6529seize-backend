import { DropPollsApiService } from '@/api/drops/drop-polls.api.service';
import { DropType } from '@/entities/IDrop';
import { Time } from '@/time';
import { WavesPollsPausedException } from '@/waves-freeze/waves-chain-polls';
import { stubWavesScope } from '@/tests/fixtures/waves-scope.fixture';

const NAMES = [
  'FEATURE_WAVES_FROZEN',
  'WAVES_FREEZE_AT',
  'FEATURE_WAVES_ON_CHAIN',
  'WAVES_SWITCH_ON_AT',
  'FEATURE_WAVES_CHAIN_POLLS'
];
const SWITCH_ON = Date.UTC(2026, 10, 28);
const LATER = Date.UTC(2027, 0, 1);

function createService() {
  const dropPollsDb = { createPoll: jest.fn() };
  const wavesApiDb = {
    findById: jest.fn().mockResolvedValue({
      created_by: 'author',
      admin_group_id: null,
      chat_enabled: true
    })
  };
  const userGroupsService = {
    getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
  };
  const service = new DropPollsApiService(
    dropPollsDb as any,
    {} as any,
    wavesApiDb as any,
    userGroupsService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  return { service, dropPollsDb, wavesApiDb };
}

function createPoll(service: DropPollsApiService, waveId: string) {
  return service.createPollForDrop(
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
      waveId,
      authorId: 'author',
      dropType: DropType.CHAT
    },
    {}
  );
}

describe('new polls from the switch-on, until 6529.io shows chain polls', () => {
  const original: Record<string, string | undefined> = {};
  let now: jest.SpyInstance;
  beforeAll(() => {
    for (const name of NAMES) original[name] = process.env[name];
  });
  beforeEach(() => {
    // No freeze here: the switch-on and the setting decide alone.
    for (const name of NAMES) delete process.env[name];
    process.env.WAVES_SWITCH_ON_AT = new Date(SWITCH_ON).toISOString();
    now = jest.spyOn(Time, 'currentMillis').mockReturnValue(SWITCH_ON + 1);
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

  it('makes no poll in a moved wave after the switch-on with the setting off', async () => {
    const { service, dropPollsDb, wavesApiDb } = createService();
    await expect(createPoll(service, 'moved-wave')).rejects.toBeInstanceOf(
      WavesPollsPausedException
    );
    expect(wavesApiDb.findById).not.toHaveBeenCalled();
    expect(dropPollsDb.createPoll).not.toHaveBeenCalled();
  });

  it('makes the poll with the setting on', async () => {
    process.env.FEATURE_WAVES_CHAIN_POLLS = 'true';
    const { service, dropPollsDb } = createService();
    await expect(createPoll(service, 'moved-wave')).resolves.toBeUndefined();
    expect(dropPollsDb.createPoll).toHaveBeenCalledTimes(1);
  });

  it('makes the poll in a staying wave', async () => {
    const { service, dropPollsDb } = createService();
    await expect(createPoll(service, 'staying-wave')).resolves.toBeUndefined();
    expect(dropPollsDb.createPoll).toHaveBeenCalledTimes(1);
  });

  it('makes the poll before the switch-on', async () => {
    now.mockReturnValue(SWITCH_ON - 1);
    const { service, dropPollsDb } = createService();
    await expect(createPoll(service, 'moved-wave')).resolves.toBeUndefined();
    expect(dropPollsDb.createPoll).toHaveBeenCalledTimes(1);
  });

  it('makes no poll when the switch-on passes after the early check', async () => {
    now.mockReturnValue(SWITCH_ON - 1);
    const { service, dropPollsDb, wavesApiDb } = createService();
    wavesApiDb.findById.mockImplementation(async () => {
      now.mockReturnValue(SWITCH_ON + 1);
      return { created_by: 'author', admin_group_id: null, chat_enabled: true };
    });
    await expect(createPoll(service, 'moved-wave')).rejects.toBeInstanceOf(
      WavesPollsPausedException
    );
    expect(wavesApiDb.findById).toHaveBeenCalledTimes(1);
    expect(dropPollsDb.createPoll).not.toHaveBeenCalled();
  });
});
