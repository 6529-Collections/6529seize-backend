import { Interface, JsonRpcProvider } from 'ethers';
import { MarketChain } from '@/marketplace/market-chain';
import { transactionDto } from '@/api/marketplace/marketplace.dto';
import type { MarketTradeIntent } from '@/marketplace/provider.types';
import {
  MARKET_OPENSEA_CONDUIT_KEY,
  MARKET_WETH,
  MARKET_ZERO_ADDRESS,
  marketSpender
} from '@/marketplace/seaport.registry';

const wallet = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const spender = marketSpender(MARKET_OPENSEA_CONDUIT_KEY);
const abi = new Interface([
  'function ownerOf(uint256) view returns (address)',
  'function getApproved(uint256) view returns (address)',
  'function isApprovedForAll(address,address) view returns (bool)',
  'function balanceOf(address,uint256) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256)',
  'function setApprovalForAll(address,bool)'
]);
const intent: MarketTradeIntent = {
  kind: 'LIST',
  chainId: 1,
  wallet,
  recipient: wallet,
  asset: {
    contract: '0x33fd426905f149f8376e227d0c9d3340aad17af1',
    tokenId: '56',
    standard: 'ERC1155'
  },
  quantity: '2',
  currency: MARKET_WETH,
  maxTotalWei: '200',
  minNetWei: '198',
  fees: [{ recipient, amountWei: '2' }],
  includeOptionalCreatorFees: false,
  startTime: '1800000000',
  endTime: '1800001000'
};

function fixture() {
  const state = {
    approved: false,
    tokenApproved: MARKET_ZERO_ADDRESS,
    allowance: '0',
    wethBalance: '200',
    rejectApproval: false
  };
  const rpc = {
    call: jest.fn(async (request: { data: string }) => {
      const call = abi.parseTransaction(request)!;
      if (['approve', 'setApprovalForAll'].includes(call.name)) {
        if (state.rejectApproval) throw new Error('untrusted RPC details');
        return '0x';
      }
      const result: Record<string, string | boolean> = {
        'ownerOf(uint256)': wallet,
        'getApproved(uint256)': state.tokenApproved,
        'isApprovedForAll(address,address)': state.approved,
        'balanceOf(address,uint256)': '2',
        'balanceOf(address)': state.wethBalance,
        'allowance(address,address)': state.allowance
      };
      return abi.encodeFunctionResult(call.fragment, [result[call.signature]]);
    }),
    estimateGas: jest.fn().mockResolvedValue(BigInt(50000)),
    getFeeData: jest.fn().mockResolvedValue({ maxFeePerGas: BigInt(10) }),
    getBalance: jest.fn().mockResolvedValue(BigInt(1000000))
  };
  return {
    state,
    rpc,
    chain: new MarketChain(rpc as unknown as JsonRpcProvider)
  };
}

it('simulates the exact ERC1155 collection approval and includes bounded gas in the wallet DTO', async () => {
  const { chain, rpc } = fixture();
  const [approval] = await chain.approvals(intent);
  expect(approval).toMatchObject({
    from: wallet,
    to: intent.asset.contract,
    value: '0',
    approvalScope: 'COLLECTION',
    purpose: 'APPROVE_NFT'
  });
  const decoded = abi.parseTransaction(approval)!;
  expect(decoded.name).toBe('setApprovalForAll');
  expect(decoded.args[0].toLowerCase()).toBe(spender);
  expect(decoded.args[1]).toBe(true);
  const exact = {
    from: wallet,
    to: approval.to,
    data: approval.data,
    value: BigInt(0)
  };
  expect(rpc.call).toHaveBeenCalledWith(exact);
  expect(rpc.estimateGas).toHaveBeenCalledWith(exact);
  expect(transactionDto(approval)).toMatchObject({
    gas_limit: '60000',
    max_fee_per_gas: '10',
    gas_reserve_wei: '600000'
  });
});

it('uses token-specific ERC721 approval and never adds collection approval', async () => {
  const { chain } = fixture();
  const [approval] = await chain.approvals({
    ...intent,
    asset: {
      contract: '0x0c58ef43ff3032005e472cb5709f8908acb00205',
      tokenId: '37',
      standard: 'ERC721'
    },
    quantity: '1'
  });
  const decoded = abi.parseTransaction(approval)!;
  expect(decoded.name).toBe('approve');
  expect(decoded.args[0].toLowerCase()).toBe(spender);
  expect(decoded.args[1]).toBe(BigInt(37));
  expect(approval.approvalScope).toBe('TOKEN');
  expect(approval.gas?.gas_reserve_wei).toBe('600000');
});

it.each(['BUY', 'OFFER'] as const)(
  'simulates a finite exact WETH amount for %s',
  async (kind) => {
    const { chain } = fixture();
    const [approval] = await chain.approvals({ ...intent, kind });
    expect(approval.to).toBe(MARKET_WETH);
    expect(approval.approvalScope).toBe('CURRENCY_AMOUNT');
    expect(abi.parseTransaction(approval)!.args[1]).toBe(BigInt(200));
    expect(approval.gas?.max_fee_per_gas).toBe('10');
  }
);

it('prices both ACCEPT approvals when signed fees are funded by incoming WETH', async () => {
  const { chain, state, rpc } = fixture();
  state.wethBalance = '0';
  const approvals = await chain.approvals({ ...intent, kind: 'ACCEPT' });
  expect(approvals.map((tx) => tx.purpose)).toEqual([
    'APPROVE_NFT',
    'APPROVE_CURRENCY'
  ]);
  expect(abi.parseTransaction(approvals[1])!.args[1]).toBe(BigInt(2));
  expect(approvals.every((tx) => tx.gas?.gas_limit === '60000')).toBe(true);
  expect(rpc.estimateGas).toHaveBeenCalledTimes(2);
});

it('does not simulate or request gas for approvals already satisfied on chain', async () => {
  const { chain, state, rpc } = fixture();
  state.approved = true;
  state.allowance = '200';
  await expect(chain.approvals(intent)).resolves.toEqual([]);
  await expect(chain.approvals({ ...intent, kind: 'BUY' })).resolves.toEqual(
    []
  );
  expect(rpc.estimateGas).not.toHaveBeenCalled();
  expect(rpc.getFeeData).not.toHaveBeenCalled();
});

it.each(['call', 'estimate', 'gas-zero', 'fee-null', 'fee-zero', 'funding'])(
  'fails closed before exposing an approval when %s is unavailable',
  async (failure) => {
    const { chain, state, rpc } = fixture();
    if (failure === 'call') state.rejectApproval = true;
    if (failure === 'estimate')
      rpc.estimateGas.mockRejectedValue(new Error('rpc'));
    if (failure === 'gas-zero') rpc.estimateGas.mockResolvedValue(BigInt(0));
    if (failure === 'fee-null')
      rpc.getFeeData.mockResolvedValue({ maxFeePerGas: null });
    if (failure === 'fee-zero')
      rpc.getFeeData.mockResolvedValue({ maxFeePerGas: BigInt(0) });
    if (failure === 'funding') rpc.getBalance.mockResolvedValue(BigInt(599999));
    await expect(chain.approvals(intent)).rejects.toThrow(
      'The transaction could not be simulated safely. Refresh balances and approvals.'
    );
  }
);
