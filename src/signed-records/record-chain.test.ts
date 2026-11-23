import { recordAnchorService } from './record-anchor';
import { wireSignedRecordsChain } from './record-chain';
import { recordOwnerDirectory } from './record-owner-directory';

describe('wireSignedRecordsChain', () => {
  afterEach(() => {
    wireSignedRecordsChain(null);
  });

  it('wires the anchor height and the owners from one client, and unwires both', async () => {
    const client = {
      getHead: async () => ({
        headHeight: 12,
        finalizedHeight: 10,
        finalizedTime: 1_795_000_000_000
      }),
      getMembershipWalletHistory: async () => null,
      getIdentityByWallet: async () => null,
      getIdentityByPrincipal: async () => null
    };
    wireSignedRecordsChain(client);
    expect(recordOwnerDirectory.hasChain()).toBe(true);
    await expect(recordAnchorService.getAnchor()).resolves.toMatchObject({
      anchor: 10
    });
    wireSignedRecordsChain(null);
    expect(recordOwnerDirectory.hasChain()).toBe(false);
    await expect(recordAnchorService.getAnchor()).rejects.toThrow(
      'not configured'
    );
  });
});
