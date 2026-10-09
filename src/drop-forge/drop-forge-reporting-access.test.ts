import { validateForgeReporting } from '@/drop-forge/drop-forge.reporting-access';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { identitiesDb } from '@/identities/identities.db';

jest.mock('@/api/waves/waves.api.db', () => ({
  wavesApiDb: { findWaveById: jest.fn() }
}));
jest.mock('@/api/community-members/user-groups.service', () => ({
  userGroupsService: { findIdentityGroupMemberships: jest.fn() }
}));
jest.mock('@/identities/identities.db', () => ({
  identitiesDb: {
    getIdentityByProfileId: jest.fn(),
    getIdentitiesByIds: jest.fn()
  }
}));

const config = {
  waveId: 'wave',
  botId: 'bot',
  recipientIds: ['admin', 'admin']
};
describe('Drop Forge reporting access', () => {
  beforeEach(() => {
    jest
      .mocked(identitiesDb.getIdentityByProfileId)
      .mockResolvedValue({ handle: 'forge-bot' } as never);
    jest
      .mocked(identitiesDb.getIdentitiesByIds)
      .mockResolvedValue([{}] as never);
    jest.mocked(wavesApiDb.findWaveById).mockResolvedValue({
      chat_enabled: true,
      visibility_group_id: 'visibility',
      chat_group_id: 'chat',
      parent_wave_id: null
    } as Awaited<ReturnType<typeof wavesApiDb.findWaveById>>);
    jest
      .mocked(userGroupsService.findIdentityGroupMemberships)
      .mockResolvedValue([
        { profileId: 'bot', groupId: 'visibility' },
        { profileId: 'bot', groupId: 'chat' },
        { profileId: 'admin', groupId: 'visibility' }
      ] as never);
  });
  afterEach(() => jest.clearAllMocks());
  it('deduplicates recipients and requires bot posting and recipient visibility', async () => {
    expect(await validateForgeReporting(config, {})).toBe('forge-bot');
    expect(identitiesDb.getIdentitiesByIds).toHaveBeenCalledWith(
      ['admin'],
      undefined
    );
  });
  it('rejects a bot outside the wave chat group', async () => {
    jest
      .mocked(userGroupsService.findIdentityGroupMemberships)
      .mockResolvedValue([
        { profileId: 'bot', groupId: 'visibility' },
        { profileId: 'admin', groupId: 'visibility' }
      ] as never);
    await expect(validateForgeReporting(config, {})).rejects.toThrow(
      'bot cannot'
    );
  });
  it('rejects recipients outside the reporting visibility group', async () => {
    jest
      .mocked(userGroupsService.findIdentityGroupMemberships)
      .mockResolvedValue([
        { profileId: 'bot', groupId: 'visibility' },
        { profileId: 'bot', groupId: 'chat' }
      ] as never);
    await expect(validateForgeReporting(config, {})).rejects.toThrow(
      'recipients cannot'
    );
  });
  it('rejects a missing parent wave and disabled chat', async () => {
    jest
      .mocked(wavesApiDb.findWaveById)
      .mockResolvedValueOnce({
        chat_enabled: true,
        parent_wave_id: 'missing'
      } as Awaited<ReturnType<typeof wavesApiDb.findWaveById>>)
      .mockResolvedValueOnce(null);
    await expect(validateForgeReporting(config, {})).rejects.toThrow(
      'parent wave'
    );
    jest
      .mocked(wavesApiDb.findWaveById)
      .mockResolvedValueOnce({ chat_enabled: false } as Awaited<
        ReturnType<typeof wavesApiDb.findWaveById>
      >);
    await expect(validateForgeReporting(config, {})).rejects.toThrow(
      'allow chat'
    );
  });
});
