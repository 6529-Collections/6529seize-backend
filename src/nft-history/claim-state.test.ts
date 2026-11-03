import { AbiCoder } from 'ethers';
import { MEMES_CONTRACT, MANIFOLD_LAZY_CLAIM_CONTRACT } from '@/constants';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { readHistoryClaim } from './claim-state';

jest.mock('@/ethereum-rpc/ethereum-rpc-client', () => ({
  getEthereumRpcClient: jest.fn()
}));
const common =
  'uint32 total,uint32 totalMax,uint32 walletMax,uint48 startDate,uint48 endDate,uint8 storageProtocol,bytes32 merkleRoot,string location,uint256 tokenId,uint256 cost,address paymentReceiver';
it.each([0, 1, 2])(
  'decodes only the actual %i-tail deployed claim layout',
  async (extra) => {
    const fields =
      common +
      ',address erc20,address signingAddress'
        .split(',')
        .slice(1, extra + 1)
        .map((field) => ',' + field)
        .join('');
    const values = [
      1,
      500,
      0,
      0,
      0,
      2,
      '0x' + '0'.repeat(64),
      'location',
      569,
      0,
      MEMES_CONTRACT,
      ...Array(extra).fill(MEMES_CONTRACT)
    ];
    const raw = AbiCoder.defaultAbiCoder().encode(
      [`tuple(${fields})`],
      [values]
    );
    const call = jest.fn().mockResolvedValue(raw);
    jest
      .mocked(getEthereumRpcClient)
      .mockReturnValue({ call } as unknown as ReturnType<
        typeof getEthereumRpcClient
      >);
    await expect(
      readHistoryClaim(
        MANIFOLD_LAZY_CLAIM_CONTRACT,
        MEMES_CONTRACT,
        '12345',
        100
      )
    ).resolves.toEqual({
      tokenId: 569,
      total: '1',
      location: 'location',
      uri: 'https://arweave.net/location'
    });
    expect(call.mock.calls[0][1]).toBe(100);
  }
);

it('rejects unknown emitters and malformed tuple heads rather than fabricating a mapping', async () => {
  const call = jest.fn().mockResolvedValue('0x' + '0'.repeat(640));
  jest
    .mocked(getEthereumRpcClient)
    .mockReturnValue({ call } as unknown as ReturnType<
      typeof getEthereumRpcClient
    >);
  await expect(
    readHistoryClaim(MEMES_CONTRACT, MEMES_CONTRACT, '12345', 100)
  ).rejects.toThrow('Unverified');
  expect(call).not.toHaveBeenCalled();
  await expect(
    readHistoryClaim(MANIFOLD_LAZY_CLAIM_CONTRACT, MEMES_CONTRACT, '12345', 100)
  ).rejects.toThrow('layout');
});
