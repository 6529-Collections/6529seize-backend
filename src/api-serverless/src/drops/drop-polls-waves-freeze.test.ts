import { DropPollsApiService } from '@/api/drops/drop-polls.api.service';
import { AuthenticationContext } from '@/auth-context';
import { DropType } from '@/entities/IDrop';
import { WavesFrozenException } from '@/waves-freeze/waves-freeze';

const FLAG = 'FEATURE_WAVES_FROZEN';

function createService() {
  const dropPollsDb = { createPoll: jest.fn() };
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
    {} as any,
    userGroupsService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  return { service, dropPollsDb, dropsDb };
}

const ctx = {
  authenticationContext: new AuthenticationContext({
    authenticatedWallet: '0x1111111111111111111111111111111111111111',
    authenticatedProfileId: 'voter',
    roleProfileId: null,
    activeProxyActions: []
  })
};

describe('polls during the waves freeze', () => {
  const original = process.env[FLAG];
  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
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

  it('takes no poll vote while frozen', async () => {
    process.env[FLAG] = 'true';
    const { service, dropsDb } = createService();
    await expect(
      service.vote({ dropId: 'drop', voterId: 'voter', options: [1] }, ctx)
    ).rejects.toBeInstanceOf(WavesFrozenException);
    expect(dropsDb.findDropByIdWithEligibilityCheck).not.toHaveBeenCalled();
  });

  it('takes poll votes as before when not frozen', async () => {
    delete process.env[FLAG];
    const { service } = createService();
    await expect(
      service.vote({ dropId: 'drop', voterId: 'voter', options: [1] }, ctx)
    ).rejects.toThrow('past the waves freeze check');
  });
});
