import { getTdhForAddress, rememeExists } from '@/db-api';
import { validateRememe, validateTDH } from './rememes_validation';

const mockGetContractMetadata = jest.fn();
const mockGetNftMetadata = jest.fn();

jest.mock('@/db-api', () => ({
  getTdhForAddress: jest.fn(),
  rememeExists: jest.fn()
}));

jest.mock('@/alchemy-sdk', () => ({
  Alchemy: jest.fn().mockImplementation(() => ({
    nft: {
      getContractMetadata: mockGetContractMetadata,
      getNftMetadata: mockGetNftMetadata
    }
  })),
  Network: {
    ETH_MAINNET: 'eth-mainnet'
  }
}));

jest.mock('@/api/seize-settings', () => ({
  seizeSettings: () => ({
    rememes_submission_tdh_threshold: 100
  })
}));

const getTdhForAddressMock = getTdhForAddress as jest.MockedFunction<
  typeof getTdhForAddress
>;
const rememeExistsMock = rememeExists as jest.MockedFunction<
  typeof rememeExists
>;

describe('validateRememe', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns an invalid response when token metadata fetch fails', async () => {
    mockGetContractMetadata.mockResolvedValue({
      address: '0xcontract',
      contractDeployer: '0xdeployer'
    });
    mockGetNftMetadata.mockRejectedValue(new Error('metadata unavailable'));

    const req: any = {
      body: {
        contract: '0xcontract',
        token_ids: ['1'],
        references: [1]
      }
    };
    const next = jest.fn();

    await validateRememe(req, {}, next);

    expect(req.validatedBody).toEqual({
      valid: false,
      contract: {
        address: '0xcontract',
        contractDeployer: '0xdeployer'
      },
      nfts: [
        {
          metadataError:
            'Error fetching metadata for token_id 1: metadata unavailable'
        }
      ]
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('uses the request contract when Alchemy contract metadata has no address', async () => {
    mockGetContractMetadata.mockResolvedValue({
      contractDeployer: '0xdeployer',
      tokenType: 'ERC721'
    });
    mockGetNftMetadata.mockResolvedValue({
      tokenId: '1',
      raw: {
        metadata: {}
      }
    });
    rememeExistsMock.mockResolvedValue(false);

    const req: any = {
      body: {
        contract: '0xcontract',
        token_ids: ['1'],
        references: [1]
      }
    };

    await validateRememe(req, {}, jest.fn());

    expect(req.validatedBody.contract).toEqual({
      address: '0xcontract',
      contractDeployer: '0xdeployer',
      tokenType: 'ERC721'
    });
    expect(req.validatedBody.valid).toBe(true);
  });
});

describe('validateTDH', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('validates TDH when contract deployer metadata is missing', async () => {
    getTdhForAddressMock.mockResolvedValue(101);

    await expect(validateTDH('0xabc')).resolves.toBe(true);

    expect(getTdhForAddressMock).toHaveBeenCalledWith('0xabc');
  });

  it('allows the contract deployer without checking TDH', async () => {
    await expect(validateTDH('0xabc', '0xABC')).resolves.toBe(true);

    expect(getTdhForAddressMock).not.toHaveBeenCalled();
  });

  it('rejects addresses below the TDH threshold', async () => {
    getTdhForAddressMock.mockResolvedValue(99);

    await expect(validateTDH('0xabc')).resolves.toBe(false);
  });
});
