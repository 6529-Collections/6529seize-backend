import { getTdhForAddress, rememeExists } from '@/db-api';
import { verifyStructuredWalletSignature } from '@/api/wallet-signatures/structured-wallet-signatures';
import {
  MAX_REMEME_TOKEN_IDS,
  validateRememe,
  validateRememeAdd
} from './rememes_validation';

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
  Network: { ETH_MAINNET: 'eth-mainnet' }
}));

jest.mock('@/api/seize-settings', () => ({
  seizeSettings: () => ({ rememes_submission_tdh_threshold: 100 })
}));

jest.mock('@/api/wallet-signatures/structured-wallet-signatures', () => ({
  ETHEREUM_MAINNET_CHAIN_ID: 1,
  hashStructuredWalletSignaturePayload: jest.fn(() => 'hash'),
  isStructuredSignaturesRequired: jest.fn(() => true),
  verifyStructuredWalletSignature: jest.fn()
}));

const ADDRESS = '0x0000000000000000000000000000000000000001';

function addBody(tokenIds: string[] = ['1']) {
  return {
    address: ADDRESS,
    signature: '0xsig',
    signature_message: 'message',
    rememe: { contract: '0xcontract', token_ids: tokenIds, references: [1] }
  };
}

async function runAdd(body: unknown) {
  const req: any = { body };
  const next = jest.fn();
  await validateRememeAdd(req, {}, next);
  expect(next).toHaveBeenCalledTimes(1);
  return req.validatedBody;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetContractMetadata.mockResolvedValue({
    address: '0xcontract',
    contractDeployer: '0xdeployer'
  });
  mockGetNftMetadata.mockResolvedValue({ tokenId: '1' });
  jest.mocked(rememeExists).mockResolvedValue(false);
  jest.mocked(getTdhForAddress).mockResolvedValue(1000);
});

describe('validateRememeAdd', () => {
  it('rejects an invalid signature before any provider lookup', async () => {
    jest.mocked(verifyStructuredWalletSignature).mockResolvedValue(null);

    expect(await runAdd(addBody())).toEqual({
      valid: false,
      error: 'Invalid signature'
    });
    expect(mockGetContractMetadata).not.toHaveBeenCalled();
    expect(mockGetNftMetadata).not.toHaveBeenCalled();
  });

  it('rejects too many token ids before signature or provider work', async () => {
    const tokenIds = Array.from({ length: MAX_REMEME_TOKEN_IDS + 1 }, (_, i) =>
      String(i)
    );

    const result = await runAdd(addBody(tokenIds));

    expect(result.valid).toBe(false);
    expect(verifyStructuredWalletSignature).not.toHaveBeenCalled();
    expect(mockGetNftMetadata).not.toHaveBeenCalled();
  });

  it('looks up metadata and TDH for a signed submission', async () => {
    jest.mocked(verifyStructuredWalletSignature).mockResolvedValue(ADDRESS);

    const result = await runAdd(addBody());

    expect(result).toMatchObject({
      valid: true,
      address: ADDRESS,
      references: [1]
    });
    expect(mockGetNftMetadata).toHaveBeenCalledTimes(1);
    expect(getTdhForAddress).toHaveBeenCalledWith(ADDRESS);
  });

  it('reports insufficient TDH after a valid signature', async () => {
    jest.mocked(verifyStructuredWalletSignature).mockResolvedValue(ADDRESS);
    jest.mocked(getTdhForAddress).mockResolvedValue(1);

    expect(await runAdd(addBody())).toEqual({
      valid: false,
      error: 'Insufficient TDH'
    });
  });

  it('answers an empty body without provider lookups', async () => {
    expect((await runAdd(undefined)).valid).toBe(false);
    expect(mockGetContractMetadata).not.toHaveBeenCalled();
  });
});

describe('validateRememe token id bound', () => {
  it('rejects more than the maximum token ids without provider lookups', async () => {
    const req: any = {
      body: {
        contract: '0xcontract',
        token_ids: Array.from({ length: MAX_REMEME_TOKEN_IDS + 1 }, (_, i) =>
          String(i)
        ),
        references: [1]
      }
    };
    await validateRememe(req, {}, jest.fn());
    expect(req.validatedBody.valid).toBe(false);
    expect(mockGetContractMetadata).not.toHaveBeenCalled();
  });

  it('accepts the maximum number of token ids', async () => {
    const req: any = {
      body: {
        contract: '0xcontract',
        token_ids: Array.from({ length: MAX_REMEME_TOKEN_IDS }, (_, i) =>
          String(i)
        ),
        references: [1]
      }
    };
    await validateRememe(req, {}, jest.fn());
    expect(req.validatedBody.valid).toBe(true);
    expect(mockGetNftMetadata).toHaveBeenCalledTimes(MAX_REMEME_TOKEN_IDS);
  });
});
