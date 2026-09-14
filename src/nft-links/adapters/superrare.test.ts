import { Contract, ZeroAddress } from 'ethers';
import SuperRareAdapter from '@/nft-links/adapters/superrare';
import { fetchJsonWithTimeout } from '@/nft-links/lib/http';
import { CanonicalLink } from '@/nft-links/types';

jest.mock('ethers', () => ({
  ...jest.requireActual('ethers'),
  Contract: jest.fn()
}));
jest.mock('@/nft-links/lib/http', () => ({
  fetchJsonWithTimeout: jest.fn()
}));
jest.mock('@/nft-links/lib/onchain', () => ({
  getProvider: () => ({}),
  getErc20Meta: jest.fn(),
  formatTokenAmount: jest.requireActual('ethers').formatUnits
}));

const contractAddress = '0x1111111111111111111111111111111111111111';
const canonical: CanonicalLink = {
  platform: 'SUPERRARE',
  canonicalId: `SUPERRARE:eth:${contractAddress}:1`,
  originalUrl: `https://superrare.com/artwork/eth/${contractAddress}/1`,
  viewUrl: `https://superrare.com/artwork/eth/${contractAddress}/1`,
  identifiers: {
    kind: 'TOKEN',
    chain: 'eth',
    contract: contractAddress,
    tokenId: '1'
  }
};
const fetchJsonMock = jest.mocked(fetchJsonWithTimeout);
const nft = {
  tokenURI: jest.fn(),
  name: jest.fn(),
  supportsInterface: jest.fn(),
  uri: jest.fn()
};
const market = {
  getSalePrice: jest.fn(),
  getAuctionDetails: jest.fn(),
  auctionBids: jest.fn()
};
const metadata = {
  name: 'Synthetic artwork',
  description: 'Synthetic description',
  image: 'https://example.com/image.png'
};
const originalEnv = { ...process.env };

function contractRevert() {
  return Object.assign(new Error('execution reverted'), {
    code: 'CALL_EXCEPTION',
    data: '0x'
  });
}

function useErc1155() {
  const error = contractRevert();
  nft.tokenURI.mockRejectedValue(error);
  nft.supportsInterface.mockResolvedValue(true);
  nft.uri.mockResolvedValue('https://example.com/1155/{id}.json');
  return error;
}

async function resolve(tokenId = '1') {
  return new SuperRareAdapter().resolveFast({
    ...canonical,
    identifiers: {
      ...canonical.identifiers,
      kind: 'TOKEN',
      chain: 'eth',
      contract: contractAddress,
      tokenId
    }
  });
}

describe('SuperRare metadata standard compatibility', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.SUPERRARE_BAZAAR_ADDRESS;
    delete process.env.SUPERRARE_TIMEOUT_MS;
    jest.mocked(Contract).mockImplementation((address) => {
      return (address === contractAddress
        ? nft
        : market) as unknown as Contract;
    });
    market.getSalePrice.mockResolvedValue([]);
    market.getAuctionDetails.mockResolvedValue([]);
    nft.tokenURI.mockResolvedValue('https://example.com/721.json');
    nft.name.mockResolvedValue('Synthetic collection');
    fetchJsonMock.mockResolvedValue(metadata);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('preserves successful ERC721 metadata and fixed-price output without interface probes', async () => {
    market.getSalePrice.mockResolvedValue([
      contractAddress,
      ZeroAddress,
      BigInt('1500000000000000000')
    ]);
    const result = await resolve();
    expect(result?.patch.asset).toMatchObject({
      title: metadata.name,
      description: metadata.description,
      collection: { name: 'Synthetic collection' },
      media: { kind: 'image', imageUrl: metadata.image }
    });
    expect(result?.patch.market).toMatchObject({
      saleType: 'FIXED',
      price: { amount: '1.5', currency: 'ETH' }
    });
    expect(fetchJsonMock).toHaveBeenCalledWith('https://example.com/721.json', {
      timeoutMs: 1800
    });
    expect(nft.supportsInterface).not.toHaveBeenCalled();
    expect(nft.uri).not.toHaveBeenCalled();
  });

  it('resolves the ERC1155 shape whose ERC721 tokenURI reverts', async () => {
    useErc1155();
    const result = await resolve();
    expect(nft.supportsInterface).toHaveBeenCalledWith('0xd9b67a26');
    expect(nft.uri).toHaveBeenCalledWith(BigInt(1));
    expect(fetchJsonMock).toHaveBeenCalledWith(
      `https://example.com/1155/${'1'.padStart(64, '0')}.json`,
      { timeoutMs: 1800 }
    );
    expect(result?.patch.asset?.media?.imageUrl).toBe(metadata.image);
  });

  it.each([false, true])(
    'uses the real ethers ABI for ERC1155 fallback (malformed interface: %s)',
    async (malformedInterface) => {
      const ethers = jest.requireActual<typeof import('ethers')>('ethers');
      const observedMethods: string[] = [];
      jest.mocked(Contract).mockImplementation((address, abi) => {
        if (address !== contractAddress) return market as unknown as Contract;
        const iface = ethers.Interface.from(abi);
        return new ethers.Contract(address, abi, {
          provider: null,
          call: async (transaction) => {
            const data = transaction.data!;
            const decoded = iface.parseTransaction({ data })!;
            observedMethods.push(decoded.name);
            if (decoded.name === 'tokenURI') {
              throw iface.makeError('0x', { to: contractAddress, data });
            }
            if (decoded.name === 'supportsInterface') {
              expect(decoded.args[0]).toBe('0xd9b67a26');
              return malformedInterface
                ? '0x'
                : iface.encodeFunctionResult(decoded.name, [true]);
            }
            if (decoded.name === 'uri') {
              expect(decoded.args[0]).toBe(BigInt(1));
              return iface.encodeFunctionResult(decoded.name, [
                'https://example.com/1155/{id}.json'
              ]);
            }
            expect(decoded.name).toBe('name');
            return iface.encodeFunctionResult(decoded.name, ['Collection']);
          }
        });
      });
      if (malformedInterface) {
        await expect(resolve()).rejects.toMatchObject({
          code: 'CALL_EXCEPTION',
          invocation: { method: 'tokenURI' }
        });
        expect(observedMethods).not.toContain('uri');
        expect(fetchJsonMock).not.toHaveBeenCalled();
      } else {
        const result = await resolve();
        expect(result?.patch.asset?.title).toBe(metadata.name);
        expect(observedMethods).toEqual(
          expect.arrayContaining([
            'tokenURI',
            'name',
            'supportsInterface',
            'uri'
          ])
        );
        expect(fetchJsonMock.mock.calls[0]?.[0]).toBe(
          `https://example.com/1155/${'1'.padStart(64, '0')}.json`
        );
      }
    }
  );

  it.each(['0', '314592', ((BigInt(1) << BigInt(256)) - BigInt(1)).toString()])(
    'expands every ERC1155 placeholder for token %s using 64 lowercase hexadecimal digits',
    async (tokenId) => {
      useErc1155();
      nft.uri.mockResolvedValue('https://example.com/{id}/{id}.json');
      const hexId = BigInt(tokenId).toString(16).padStart(64, '0');
      await resolve(tokenId);
      expect(fetchJsonMock).toHaveBeenCalledWith(
        `https://example.com/${hexId}/${hexId}.json`,
        { timeoutMs: 1800 }
      );
    }
  );

  it('normalizes an ERC1155 IPFS metadata URI through the existing resolver', async () => {
    useErc1155();
    const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqsnhrjxrzhrtnvfzme4';
    nft.uri.mockResolvedValue(`ipfs://${cid}/{id}.json`);
    await resolve();
    expect(fetchJsonMock.mock.calls[0]?.[0]).toBe(
      `https://media.6529.io/ipfs/${cid}/${'1'.padStart(64, '0')}.json`
    );
  });

  it('expands consumed ERC1155 JSON strings including media and leaves ERC721 strings alone', async () => {
    const templated = {
      name: 'Edition {id}',
      description: 'Token {id}',
      image: 'https://example.com/{id}.png',
      animation_url: 'https://example.com/{id}.mp4'
    };
    fetchJsonMock.mockResolvedValue(templated);
    const legacy = await resolve();
    expect(legacy?.patch.asset?.title).toBe(templated.name);
    expect(legacy?.patch.asset?.media?.imageUrl).toBe(templated.image);
    useErc1155();
    const result = await resolve();
    const hexId = '1'.padStart(64, '0');
    expect(result?.patch.asset).toMatchObject({
      title: `Edition ${hexId}`,
      description: `Token ${hexId}`,
      media: {
        kind: 'animation',
        imageUrl: `https://example.com/${hexId}.png`,
        animationUrl: `https://example.com/${hexId}.mp4`
      }
    });
  });

  it('preserves existing handling of non-string title and description values', async () => {
    const malformed = {
      name: 7,
      description: { unexpected: 'metadata object' },
      image: metadata.image
    };
    fetchJsonMock.mockResolvedValue(malformed);
    const legacy = await resolve();
    useErc1155();
    const result = await resolve();
    expect(result?.patch.asset?.title).toEqual(legacy?.patch.asset?.title);
    expect(result?.patch.asset?.title).toBe(7);
    expect(result?.patch.asset?.description).toEqual(malformed.description);
    expect(result?.patch.asset?.media?.imageUrl).toBe(metadata.image);
  });

  it.each([false, undefined, null, 1, 'true'])(
    'preserves the original failure for non-positive interface response %p',
    async (support) => {
      const original = useErc1155();
      nft.supportsInterface.mockResolvedValue(support);
      await expect(resolve()).rejects.toBe(original);
      expect(nft.uri).not.toHaveBeenCalled();
      expect(fetchJsonMock).not.toHaveBeenCalled();
    }
  );

  it('preserves the original failure when the interface query reverts', async () => {
    const original = useErc1155();
    nft.supportsInterface.mockRejectedValue(contractRevert());
    await expect(resolve()).rejects.toBe(original);
    expect(nft.uri).not.toHaveBeenCalled();
  });

  it.each(['', '   ', undefined, 7])(
    'does not turn malformed/empty ERC1155 URI %p into success',
    async (uri) => {
      const original = useErc1155();
      nft.uri.mockResolvedValue(uri);
      await expect(resolve()).rejects.toBe(original);
      expect(fetchJsonMock).not.toHaveBeenCalled();
    }
  );

  it('preserves the original failure when ERC1155 uri also rejects', async () => {
    const original = useErc1155();
    nft.uri.mockRejectedValue(contractRevert());
    await expect(resolve()).rejects.toBe(original);
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });

  it.each(['TIMEOUT', 'NETWORK_ERROR', 'SERVER_ERROR'])(
    'does not add fallback RPCs after a %s transport failure',
    async (code) => {
      const original = Object.assign(new Error('synthetic transport failure'), {
        code
      });
      nft.tokenURI.mockRejectedValue(original);
      await expect(resolve()).rejects.toBe(original);
      expect(nft.supportsInterface).not.toHaveBeenCalled();
      expect(nft.uri).not.toHaveBeenCalled();
    }
  );

  it('preserves ERC1155 metadata HTTP failures and optional name behavior', async () => {
    useErc1155();
    nft.name.mockRejectedValue(contractRevert());
    const original = new Error('synthetic metadata HTTP failure');
    fetchJsonMock.mockRejectedValueOnce(original);
    await expect(resolve()).rejects.toBe(original);
    fetchJsonMock.mockResolvedValueOnce(metadata);
    const result = await resolve();
    expect(result?.patch.asset?.collection).toBeUndefined();
    expect(result?.patch.asset?.title).toBe(metadata.name);
  });
});
