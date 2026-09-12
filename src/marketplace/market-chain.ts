import { Interface, isError, JsonRpcProvider } from 'ethers';
import { getRpcUrl } from '@/alchemy';
import {
  MarketTradeIntent,
  MarketTransaction,
  MarketValidationError,
  MarketGasEstimate
} from '@/marketplace/provider.types';
import {
  MARKET_ZERO_ADDRESS,
  marketSpender,
  MARKET_OPENSEA_CONDUIT_KEY,
  MARKET_SEAPORT
} from '@/marketplace/seaport.registry';

const nft = new Interface([
  'function ownerOf(uint256) view returns (address)',
  'function balanceOf(address,uint256) view returns (uint256)',
  'function isApprovedForAll(address,address) view returns (bool)',
  'function getApproved(uint256) view returns (address)',
  'function approve(address,uint256)',
  'function setApprovalForAll(address,bool)'
]);
const erc20 = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256)'
]);
const seaport = new Interface([
  'function getCounter(address) view returns (uint256)',
  'function getOrderStatus(bytes32) view returns (bool isValidated,bool isCancelled,uint256 totalFilled,uint256 totalSize)'
]);

function simulationMismatch(): MarketValidationError {
  return new MarketValidationError(
    'ORDER_MISMATCH',
    'The transaction could not be simulated safely. Refresh balances and approvals.'
  );
}

function hasExecutionFailure(error: unknown): boolean {
  // ethers also wraps JSON-RPC outages as CALL_EXCEPTION without revert data.
  // Only a known execution failure supports telling the caller to refresh state.
  return (
    isError(error, 'INSUFFICIENT_FUNDS') ||
    (isError(error, 'CALL_EXCEPTION') &&
      typeof error.data === 'string' &&
      /^0x(?:[\da-f]{2})*$/i.test(error.data))
  );
}

export class MarketChain {
  constructor(readonly rpc: JsonRpcProvider) {}

  async snapshot() {
    const block = await this.rpc.getBlock('latest');
    if (!block?.hash || block.timestamp * 1000 < Date.now() - 120000)
      throw new MarketValidationError(
        'PROVIDER_UNAVAILABLE',
        'The chain snapshot is stale.'
      );
    const network = await this.rpc.getNetwork();
    if (network.chainId !== BigInt(1))
      throw new MarketValidationError(
        'UNSUPPORTED_PROTOCOL',
        'Incorrect chain.'
      );
    return {
      block_number: block.number,
      block_hash: block.hash,
      block_timestamp: block.timestamp
    };
  }

  async counter(wallet: string): Promise<string> {
    const raw = await this.rpc.call({
      to: MARKET_SEAPORT,
      data: seaport.encodeFunctionData('getCounter', [wallet])
    });
    return seaport.decodeFunctionResult('getCounter', raw)[0].toString();
  }

  async orderStatus(hash: string) {
    const raw = await this.rpc.call({
      to: MARKET_SEAPORT,
      data: seaport.encodeFunctionData('getOrderStatus', [hash])
    });
    const result = seaport.decodeFunctionResult('getOrderStatus', raw);
    return {
      cancelled: Boolean(result[1]),
      filled: BigInt(result[2]),
      size: BigInt(result[3])
    };
  }

  async approvals(
    intent: MarketTradeIntent,
    conduitKey = MARKET_OPENSEA_CONDUIT_KEY
  ): Promise<MarketTransaction[]> {
    const approvals = await this.approvalRequests(intent, conduitKey);
    // These fixed NFT/WETH approvals are independent of one another. Simulate
    // only the approvals; fulfillment is prepared again after they are mined.
    return Promise.all(
      approvals.map(async (transaction) => ({
        ...transaction,
        gas: await this.simulate(transaction)
      }))
    );
  }

  private async approvalRequests(
    intent: MarketTradeIntent,
    conduitKey: string
  ): Promise<MarketTransaction[]> {
    const spender = marketSpender(conduitKey);
    if (intent.kind === 'LIST') return this.nftApproval(intent, spender);
    if (intent.kind === 'ACCEPT') {
      const approvals = await this.nftApproval(intent, spender);
      const feeTotal = intent.fees.reduce(
        (total, fee) => total + BigInt(fee.amountWei),
        BigInt(0)
      );
      // Advanced offer fulfillment first transfers gross WETH to the seller;
      // the fulfiller then pays signed consideration fees from those proceeds.
      const feeApprovals = await this.currencyApproval(
        intent,
        spender,
        feeTotal
      );
      return [...approvals, ...feeApprovals];
    }
    if (intent.currency === MARKET_ZERO_ADDRESS) {
      const balance = await this.rpc.getBalance(intent.wallet);
      if (balance < BigInt(intent.maxTotalWei))
        throw new MarketValidationError(
          'AMOUNT_MISMATCH',
          'The paying wallet has insufficient ETH.'
        );
      return [];
    }
    const balance = await this.readCurrency(intent.currency, 'balanceOf', [
      intent.wallet
    ]);
    if (balance < BigInt(intent.maxTotalWei))
      throw new MarketValidationError(
        'AMOUNT_MISMATCH',
        'The paying wallet has insufficient WETH.'
      );
    return this.currencyApproval(intent, spender, BigInt(intent.maxTotalWei));
  }

  private async currencyApproval(
    intent: MarketTradeIntent,
    spender: string,
    amount: bigint
  ): Promise<MarketTransaction[]> {
    if (amount === BigInt(0)) return [];
    const allowance = await this.readCurrency(intent.currency, 'allowance', [
      intent.wallet,
      spender
    ]);
    if (allowance >= amount) return [];
    return [
      {
        kind: 'TRANSACTION',
        chainId: 1,
        from: intent.wallet,
        to: intent.currency,
        value: '0',
        data: erc20.encodeFunctionData('approve', [spender, amount]),
        purpose: 'APPROVE_CURRENCY',
        approvalScope: 'CURRENCY_AMOUNT'
      }
    ];
  }

  async currencyBalance(currency: string, wallet: string): Promise<string> {
    return (
      await this.readCurrency(currency, 'balanceOf', [wallet])
    ).toString();
  }

  private async readCurrency(
    currency: string,
    method: string,
    args: string[]
  ): Promise<bigint> {
    const result = await this.rpc.call({
      to: currency,
      data: erc20.encodeFunctionData(method, args)
    });
    return BigInt(erc20.decodeFunctionResult(method, result)[0]);
  }

  private async nftApproval(
    intent: MarketTradeIntent,
    spender: string
  ): Promise<MarketTransaction[]> {
    const call = async (method: string, args: string[]) =>
      nft.decodeFunctionResult(
        method,
        await this.rpc.call({
          to: intent.asset.contract,
          data: nft.encodeFunctionData(method, args)
        })
      )[0];
    if (intent.asset.standard === 'ERC721') {
      const owner = String(await call('ownerOf', [intent.asset.tokenId]));
      if (owner.toLowerCase() !== intent.wallet.toLowerCase())
        throw new MarketValidationError(
          'ORDER_MISMATCH',
          'The signing wallet does not own this NFT.'
        );
      if (
        String(
          await call('getApproved', [intent.asset.tokenId])
        ).toLowerCase() === spender.toLowerCase()
      )
        return [];
    } else {
      const balance = BigInt(
        await call('balanceOf', [intent.wallet, intent.asset.tokenId])
      );
      if (balance < BigInt(intent.quantity))
        throw new MarketValidationError(
          'ORDER_MISMATCH',
          'The signing wallet does not own the requested quantity.'
        );
    }
    if (await call('isApprovedForAll', [intent.wallet, spender])) return [];
    const is721 = intent.asset.standard === 'ERC721';
    return [
      {
        kind: 'TRANSACTION',
        chainId: 1,
        from: intent.wallet,
        to: intent.asset.contract,
        value: '0',
        data: nft.encodeFunctionData(
          is721 ? 'approve' : 'setApprovalForAll',
          is721 ? [spender, intent.asset.tokenId] : [spender, true]
        ),
        purpose: 'APPROVE_NFT',
        approvalScope: is721 ? 'TOKEN' : 'COLLECTION'
      }
    ];
  }

  async simulate(transaction: MarketTransaction): Promise<MarketGasEstimate> {
    const { from, to, data, value } = transaction;
    const request = { from, to, data, value: BigInt(value) };
    try {
      await this.rpc.call(request);
      const gas = await this.rpc.estimateGas(request);
      const fee = await this.rpc.getFeeData();
      if (
        gas <= BigInt(0) ||
        fee.maxFeePerGas === null ||
        fee.maxFeePerGas <= BigInt(0)
      )
        throw simulationMismatch();
      const gasLimit = (gas * BigInt(120)) / BigInt(100);
      const reserve = gasLimit * fee.maxFeePerGas;
      if ((await this.rpc.getBalance(from)) < BigInt(value) + reserve)
        throw simulationMismatch();
      return {
        gas_limit: gasLimit.toString(),
        max_fee_per_gas: fee.maxFeePerGas.toString(),
        gas_reserve_wei: reserve.toString()
      };
    } catch (error) {
      if (error instanceof MarketValidationError) throw error;
      if (hasExecutionFailure(error)) throw simulationMismatch();
      throw new MarketValidationError(
        'PROVIDER_UNAVAILABLE',
        'The chain provider could not simulate this transaction. Try again when the connection is available.'
      );
    }
  }
}

let instance: MarketChain | undefined;
export function marketChain(): MarketChain {
  if (!instance) {
    if (!process.env.ALCHEMY_API_KEY)
      throw new MarketValidationError(
        'PROVIDER_UNAVAILABLE',
        'The chain connection is not configured.'
      );
    instance = new MarketChain(
      new JsonRpcProvider(getRpcUrl(1), 1, { staticNetwork: true })
    );
  }
  return instance;
}
