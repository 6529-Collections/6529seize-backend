import { withArweaveFallback } from '@/arweave-gateway-fallback';
import { fetchGatewayMetadata } from '@/nft-history/metadata-fetch';
import {
  DECENTRALIZED_MEDIA_FILES_URL_ENV,
  filesServerFetchUrl
} from './decentralized-media';

const AR_ID = 'rebuildSeedMetadataId'.padEnd(43, '0');
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

describe('the rebuild check files source', () => {
  const env = process.env;

  afterEach(() => {
    process.env = env;
    jest.restoreAllMocks();
  });

  describe('unset, as in production', () => {
    beforeEach(() => {
      process.env = { ...env };
      delete process.env[DECENTRALIZED_MEDIA_FILES_URL_ENV];
    });

    it('changes no fetch', async () => {
      expect(filesServerFetchUrl(`https://arweave.net/${AR_ID}`)).toBeNull();
      const fetched: string[] = [];
      await withArweaveFallback(`https://arweave.net/${AR_ID}`, async (u) => {
        fetched.push(u);
        return 'ok';
      });
      expect(fetched).toEqual([`https://arweave.net/${AR_ID}`]);
    });

    it('still refuses a loopback metadata host', async () => {
      await expect(
        fetchGatewayMetadata(
          `http://127.0.0.1:9/ar/${AR_ID}`,
          new AbortController().signal
        )
      ).rejects.toThrow('Unsupported metadata gateway');
    });
  });

  describe('set', () => {
    beforeEach(() => {
      process.env = {
        ...env,
        [DECENTRALIZED_MEDIA_FILES_URL_ENV]: 'http://127.0.0.1:4100/'
      };
    });

    it.each([
      [`https://arweave.net/${AR_ID}`, `http://127.0.0.1:4100/ar/${AR_ID}`],
      [`ar://${AR_ID}`, `http://127.0.0.1:4100/ar/${AR_ID}`],
      [
        `https://media.6529.io/arweave/${AR_ID}`,
        `http://127.0.0.1:4100/ar/${AR_ID}`
      ],
      [`ipfs://${CID}/meta.json`, `http://127.0.0.1:4100/ipfs/${CID}/meta.json`]
    ])('fetches %s from the files source', (input, expected) => {
      expect(filesServerFetchUrl(input)).toBe(expected);
    });

    it.each([
      ['an IPNS name', 'ipns://example.eth'],
      ['a plain URL', 'https://example.com/1.json']
    ])('leaves %s alone', (_case, input) => {
      expect(filesServerFetchUrl(input)).toBeNull();
    });

    it('tries the files source alone, with no gateway fallback', async () => {
      const fetched: string[] = [];
      await expect(
        withArweaveFallback(`https://arweave.net/${AR_ID}`, async (u) => {
          fetched.push(u);
          throw new Error('missing');
        })
      ).rejects.toThrow('missing');
      expect(fetched).toEqual([`http://127.0.0.1:4100/ar/${AR_ID}`]);
    });

    it('lets the history fetch read from it', async () => {
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('{"name":"card"}', { status: 200 }));
      await expect(
        fetchGatewayMetadata(
          `http://127.0.0.1:4100/ar/${AR_ID}`,
          new AbortController().signal
        )
      ).resolves.toBe('{"name":"card"}');
      expect(fetchSpy).toHaveBeenCalledWith(
        `http://127.0.0.1:4100/ar/${AR_ID}`,
        expect.anything()
      );
      await expect(
        fetchGatewayMetadata(
          `http://127.0.0.1:4101/ar/${AR_ID}`,
          new AbortController().signal
        )
      ).rejects.toThrow('Unsupported metadata gateway');
    });
  });
});
