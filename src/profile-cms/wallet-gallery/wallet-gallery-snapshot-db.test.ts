import { MEMELAB_CONTRACT, MEMES_CONTRACT } from '@/constants';
import { WalletGallerySnapshotDb } from '@/profile-cms/wallet-gallery/wallet-gallery-snapshot.db';

jest.mock('@/nextgen/nextgen_constants', () => ({
  NEXTGEN_TOKENS_TABLE: 'nextgen_tokens',
  NEXTGEN_CORE_CONTRACT: {
    testnet: '0x3333333333333333333333333333333333333333'
  },
  getNextgenNetwork: () => 'testnet'
}));

describe('WalletGallerySnapshotDb', () => {
  it('does not query when there are no resolved wallets', async () => {
    const execute = jest.fn();
    const db = new WalletGallerySnapshotDb(() => ({ execute }) as any);

    await expect(db.findHoldingsByWallets([], {})).resolves.toEqual([]);

    expect(execute).not.toHaveBeenCalled();
  });

  it('queries indexed ownership and known metadata tables for resolved wallets', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const db = new WalletGallerySnapshotDb(() => ({ execute }) as any);

    await db.findHoldingsByWallets(
      ['0x1111111111111111111111111111111111111111'],
      {}
    );

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('UNION ALL'),
      expect.objectContaining({
        wallets: ['0x1111111111111111111111111111111111111111'],
        memesContract: MEMES_CONTRACT.toLowerCase(),
        memeLabContract: MEMELAB_CONTRACT.toLowerCase(),
        nextgenContract: '0x3333333333333333333333333333333333333333'
      }),
      undefined
    );
    const sql = execute.mock.calls[0][0] as string;
    expect(sql).toContain('nft_owners');
    expect(sql).toContain('nfts_meme_lab');
    expect(sql).toContain('nextgen_tokens');
  });
});
