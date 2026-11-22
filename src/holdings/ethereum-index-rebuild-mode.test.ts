import { deployerDropper } from '@/deployer-dropper';
import { NFT } from '@/entities/INFT';
import {
  buildS3UploaderJobsForMode,
  maybeAnnounceNewDiscoveries,
  NFT_MODE
} from '@/nftsLoop/nfts';
import { S3UploaderCollectionType } from '@/s3Uploader/s3-uploader.jobs';
import {
  isRebuildingEthereumIndexes,
  whileRebuildingEthereumIndexes
} from './rebuild-mode';
import { MEMES_CONTRACT } from '@/constants';

jest.mock('@/deployer-dropper', () => ({
  deployerDropper: { drop: jest.fn() }
}));
jest.mock('@/s3Uploader/s3-uploader.queue', () => ({
  ...jest.requireActual('@/s3Uploader/s3-uploader.queue'),
  isS3UploaderEnabledForEnvironment: () => true
}));
jest.mock('@/s3Uploader/s3-uploader.jobs', () => ({
  ...jest.requireActual('@/s3Uploader/s3-uploader.jobs'),
  buildS3UploaderJobsForNft: () => [{ jobType: 'image' }]
}));

const meme = {
  id: 450,
  contract: MEMES_CONTRACT,
  name: 'A card',
  image: 'https://example.com/450.png'
} as unknown as NFT;

describe('Ethereum index rebuild mode in the NFT loop', () => {
  const env = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env, DEPLOYER_ANNOUNCEMENTS_WAVE_IDS: 'wave-1' };
  });

  afterAll(() => {
    process.env = env;
  });

  it('announces a discovered Meme outside a rebuild', async () => {
    await maybeAnnounceNewDiscoveries({
      mode: NFT_MODE.DISCOVER,
      EntityClass: NFT,
      newlyDiscoveredNfts: [meme]
    });
    expect(deployerDropper.drop).toHaveBeenCalledTimes(1);
  });

  it('never announces during a rebuild, whatever the environment says', async () => {
    await whileRebuildingEthereumIndexes(() =>
      maybeAnnounceNewDiscoveries({
        mode: NFT_MODE.DISCOVER,
        EntityClass: NFT,
        newlyDiscoveredNfts: [meme]
      })
    );
    expect(deployerDropper.drop).not.toHaveBeenCalled();
  });

  it('queues no media upload during a rebuild', async () => {
    const args = {
      mode: NFT_MODE.DISCOVER,
      newlyDiscoveredNfts: [meme],
      nftMap: new Map(),
      collectionType: S3UploaderCollectionType.NFT
    };
    expect(buildS3UploaderJobsForMode(args)).toHaveLength(1);
    expect(
      await whileRebuildingEthereumIndexes(async () =>
        buildS3UploaderJobsForMode(args)
      )
    ).toEqual([]);
  });

  it('leaves rebuild mode after the work, also when it fails', async () => {
    expect(isRebuildingEthereumIndexes()).toBe(false);
    await expect(
      whileRebuildingEthereumIndexes(async () => {
        expect(isRebuildingEthereumIndexes()).toBe(true);
        throw new Error('metadata gone');
      })
    ).rejects.toThrow('metadata gone');
    expect(isRebuildingEthereumIndexes()).toBe(false);
  });

  it('stays in rebuild mode through a nested rebuild until the outer one ends', async () => {
    await whileRebuildingEthereumIndexes(async () => {
      await whileRebuildingEthereumIndexes(async () => undefined);
      expect(isRebuildingEthereumIndexes()).toBe(true);
    });
    expect(isRebuildingEthereumIndexes()).toBe(false);
  });

  it('leaves work running beside a rebuild outside rebuild mode', async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => (release = resolve));
    const seen: boolean[] = [];
    const rebuild = whileRebuildingEthereumIndexes(async () => {
      await paused;
      seen.push(isRebuildingEthereumIndexes());
    });
    // A live loop's call while the rebuild waits.
    await Promise.resolve().then(() =>
      seen.push(isRebuildingEthereumIndexes())
    );
    release();
    await rebuild;
    expect(seen).toEqual([false, true]);
  });
});
