import { profileIdByWallet } from '@/rebuild/run/probe-fixture.steps';
import { assertRecordsServiceActor } from './records-service';

jest.mock('@/rebuild/run/probe-fixture.steps', () => ({
  profileIdByWallet: jest.fn()
}));

const WALLET = '0x00000000000000000000000000000000000000c1';
const PROFILE = '00000000-0000-4000-8000-0000000000c1';

describe('the records service, as the world holds it', () => {
  it('is read by its wallet, and passes when it is the profile the flags name', async () => {
    (profileIdByWallet as jest.Mock).mockResolvedValueOnce(PROFILE);
    await expect(
      assertRecordsServiceActor(PROFILE, WALLET)
    ).resolves.toBeUndefined();
    expect(profileIdByWallet).toHaveBeenCalledWith(WALLET);
  });

  it('refuses flags that name another profile than the wallet holds', async () => {
    (profileIdByWallet as jest.Mock).mockResolvedValueOnce(PROFILE);
    await expect(
      assertRecordsServiceActor('another-profile', WALLET)
    ).rejects.toThrow(
      `belongs to profile ${PROFILE}; the records flags name another-profile`
    );
  });

  it('fails where no identity holds the wallet, as the lookup does', async () => {
    (profileIdByWallet as jest.Mock).mockRejectedValueOnce(
      new Error('no identity holds the wallet')
    );
    await expect(assertRecordsServiceActor(PROFILE, WALLET)).rejects.toThrow(
      'no identity holds the wallet'
    );
  });
});
