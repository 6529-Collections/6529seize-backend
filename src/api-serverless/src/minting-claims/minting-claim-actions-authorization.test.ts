import { Interface } from 'ethers';
import { getClaimsAdminWallets } from '@/api/seize-settings';
import { MEMES_CONTRACT } from '@/constants';
import { getEthereumRpcProvider } from '@/ethereum-rpc/ethereum-rpc-provider';
import {
  BadRequestException,
  CustomApiCompliantException,
  ForbiddenException
} from '@/exceptions';
import { assertMintingClaimActionAccess } from './minting-claim-actions.authorization';

jest.mock('@/api/seize-settings', () => ({ getClaimsAdminWallets: jest.fn() }));
jest.mock('@/ethereum-rpc/ethereum-rpc-provider', () => ({
  getEthereumRpcProvider: jest.fn()
}));
const wallet = '0x0000000000000000000000000000000000000123';
const abi = new Interface(['function isAdmin(address) view returns (bool)']);
const call = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getClaimsAdminWallets).mockReturnValue([]);
  jest
    .mocked(getEthereumRpcProvider)
    .mockReturnValue({ call } as unknown as ReturnType<
      typeof getEthereumRpcProvider
    >);
  call.mockResolvedValue(abi.encodeFunctionResult('isAdmin', [true]));
});

it('preserves configured claims admin access without RPC', async () => {
  jest.mocked(getClaimsAdminWallets).mockReturnValue([wallet.toUpperCase()]);
  await expect(
    assertMintingClaimActionAccess(wallet, MEMES_CONTRACT)
  ).resolves.toBeUndefined();
  expect(getEthereumRpcProvider).not.toHaveBeenCalled();
});

it.each(['owner', 'approved admin'])(
  'accepts the creator %s through isAdmin',
  async () => {
    await assertMintingClaimActionAccess(wallet, MEMES_CONTRACT.toLowerCase());
    expect(getEthereumRpcProvider).toHaveBeenCalledWith(1);
    expect(call).toHaveBeenCalledWith({
      to: MEMES_CONTRACT,
      data: abi.encodeFunctionData('isAdmin', [wallet])
    });
  }
);

it('never caches approval after revocation', async () => {
  call
    .mockResolvedValueOnce(abi.encodeFunctionResult('isAdmin', [true]))
    .mockResolvedValueOnce(abi.encodeFunctionResult('isAdmin', [false]));
  await assertMintingClaimActionAccess(wallet, MEMES_CONTRACT);
  await expect(
    assertMintingClaimActionAccess(wallet, MEMES_CONTRACT)
  ).rejects.toBeInstanceOf(ForbiddenException);
  expect(call).toHaveBeenCalledTimes(2);
});

it.each([null, '', 'not-a-wallet'])(
  'rejects missing or invalid wallet %s without RPC',
  async (address) => {
    await expect(
      assertMintingClaimActionAccess(address, MEMES_CONTRACT)
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(call).not.toHaveBeenCalled();
  }
);

it('rejects attacker-controlled and testnet contracts without RPC', async () => {
  for (const contract of [
    wallet,
    '0xb84170c1073c7292ed108c3f0d1d2a1f304caa2c'
  ]) {
    await expect(
      assertMintingClaimActionAccess(wallet, contract)
    ).rejects.toBeInstanceOf(BadRequestException);
  }
  expect(call).not.toHaveBeenCalled();
});

it.each([new Error('RPC failure'), null])(
  'fails closed on failed or malformed RPC responses',
  async (error) => {
    if (error) call.mockRejectedValue(error);
    else call.mockResolvedValue('0x');
    await expect(
      assertMintingClaimActionAccess(wallet, MEMES_CONTRACT)
    ).rejects.toBeInstanceOf(CustomApiCompliantException);
  }
);

it('bounds stalled permission reads', async () => {
  jest.useFakeTimers();
  try {
    call.mockReturnValue(new Promise(() => undefined));
    const result = expect(
      assertMintingClaimActionAccess(wallet, MEMES_CONTRACT)
    ).rejects.toMatchObject({
      message: expect.stringContaining('Unable to verify')
    });
    await jest.advanceTimersByTimeAsync(5000);
    await result;
  } finally {
    jest.useRealTimers();
  }
});
