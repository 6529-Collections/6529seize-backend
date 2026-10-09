import {
  Interface,
  isError,
  JsonRpcProvider,
  Transaction,
  ZeroAddress
} from 'ethers';
import { DropForgeConfig } from '@/drop-forge/drop-forge.config';
import {
  LaunchAction,
  LaunchData,
  LaunchSafetyError
} from '@/drop-forge/drop-forge.types';
import { getEthereumRpcProvider } from '@/ethereum-rpc/ethereum-rpc-provider';

async function rpcWithDeadline<T>(request: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new LaunchSafetyError('RPC verification timed out')),
          10000
        );
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const params =
  '(uint32 totalMax,uint32 walletMax,uint48 startDate,uint48 endDate,uint8 storageProtocol,bytes32 merkleRoot,string location,uint256 cost,address paymentReceiver,address erc20,address signingAddress)';
export const claimAbi = new Interface([
  `function initializeClaim(address,uint256,${params})`,
  `function updateClaim(address,uint256,${params})`,
  'function airdrop(address,uint256,address[],uint256[])',
  'function getClaim(address,uint256) view returns ((uint32 total,uint32 totalMax,uint32 walletMax,uint48 startDate,uint48 endDate,uint8 storageProtocol,bytes32 merkleRoot,string location,uint256 tokenId,uint256 cost,address paymentReceiver,address erc20,address signingAddress))',
  'error ClaimNotInitialized()'
]);
const adminAbi = new Interface([
  'function isAdmin(address) view returns (bool)'
]);
export interface ChainReceipt {
  status: number | null;
  blockNumber: number;
  blockHash: string;
  confirmations: number;
}
export interface LaunchChain {
  now(): Promise<number>;
  nonce(address: string, pending: boolean): Promise<number>;
  prepare(data: LaunchData, action: LaunchAction): Promise<string>;
  receipt(hash: string): Promise<ChainReceipt | null>;
  broadcast(raw: string): Promise<void>;
  verify(data: LaunchData, action: LaunchAction): Promise<void>;
}
export function encodeLaunchAction(
  data: LaunchData,
  action: LaunchAction
): string {
  if (action.kind === 'AIRDROP')
    return claimAbi.encodeFunctionData('airdrop', [
      data.contract,
      data.claim_id,
      action.recipients.map((row) => row.address),
      action.recipients.map((row) => row.amount)
    ]);
  const phase = data.phases[action.phase];
  return claimAbi.encodeFunctionData(
    action.kind === 'INITIALIZE' ? 'initializeClaim' : 'updateClaim',
    [
      data.contract,
      data.claim_id,
      [
        data.edition_size,
        0,
        phase.start,
        phase.end,
        2,
        phase.root,
        data.metadata,
        phase.price_wei,
        data.receiver,
        ZeroAddress,
        ZeroAddress
      ]
    ]
  );
}

export class EthereumLaunchChain implements LaunchChain {
  constructor(
    private readonly config: DropForgeConfig,
    private readonly provider: JsonRpcProvider = getEthereumRpcProvider(
      config.chainId
    )
  ) {}
  async now(): Promise<number> {
    const block = await rpcWithDeadline(this.provider.getBlock('latest'));
    if (!block || Math.abs(Date.now() / 1000 - block.timestamp) > 120)
      throw new LaunchSafetyError('RPC latest block is stale');
    return block.timestamp;
  }
  async nonce(address: string, pending: boolean): Promise<number> {
    return rpcWithDeadline(
      this.provider.getTransactionCount(address, pending ? 'pending' : 'latest')
    );
  }
  async receipt(hash: string): Promise<ChainReceipt | null> {
    const receipt = await rpcWithDeadline(
      this.provider.getTransactionReceipt(hash)
    );
    if (!receipt) return null;
    const block = await rpcWithDeadline(
      this.provider.getBlock(receipt.blockNumber)
    );
    if (block?.hash !== receipt.blockHash) return null;
    return {
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      confirmations: await rpcWithDeadline(receipt.confirmations())
    };
  }
  async broadcast(raw: string): Promise<void> {
    await rpcWithDeadline(this.provider.broadcastTransaction(raw));
  }
  async assertAdmin(wallet: string): Promise<boolean> {
    const result = await rpcWithDeadline(
      this.provider.call({
        to: this.config.creator,
        data: adminAbi.encodeFunctionData('isAdmin', [wallet])
      })
    );
    return adminAbi.decodeFunctionResult('isAdmin', result)[0] === true;
  }
  async verify(data: LaunchData, action: LaunchAction): Promise<void> {
    if (
      data.chain_id !== this.config.chainId ||
      data.contract !== this.config.creator ||
      data.signer !== this.config.signer ||
      data.proxy !== this.config.proxy ||
      data.receiver !== this.config.receiver
    )
      throw new LaunchSafetyError(
        'Runtime configuration differs from the frozen launch'
      );
    if (!(await this.assertAdmin(data.signer)))
      throw new LaunchSafetyError(
        'Operational signer lacks creator-admin permission'
      );
    let result: string;
    try {
      result = await rpcWithDeadline(
        this.provider.call({
          to: data.proxy,
          data: claimAbi.encodeFunctionData('getClaim', [
            data.contract,
            data.claim_id
          ])
        })
      );
    } catch (error) {
      if (
        action.kind === 'INITIALIZE' &&
        isError(error, 'CALL_EXCEPTION') &&
        (error.data === claimAbi.getError('ClaimNotInitialized')?.selector ||
          error.reason === 'Claim not initialized')
      )
        return;
      throw error;
    }
    if (action.kind === 'INITIALIZE')
      throw new LaunchSafetyError(
        'Claim is already initialized; automatic adoption is prohibited'
      );
    const claim = claimAbi.decodeFunctionResult('getClaim', result)[0];
    const phase = data.phases[action.kind === 'UPDATE' ? action.phase - 1 : 0];
    const equalAddress = (actual: string, expected: string) =>
      actual.toLowerCase() === expected.toLowerCase();
    const matches = [
      Number(claim.tokenId) === data.claim_id,
      Number(claim.totalMax) === data.edition_size,
      Number(claim.walletMax) === 0,
      Number(claim.startDate) === phase.start,
      Number(claim.endDate) === phase.end,
      Number(claim.storageProtocol) === 2,
      claim.merkleRoot === phase.root,
      claim.location === data.metadata,
      claim.cost.toString() === phase.price_wei,
      equalAddress(claim.paymentReceiver, data.receiver),
      equalAddress(claim.erc20, ZeroAddress),
      equalAddress(claim.signingAddress, ZeroAddress)
    ].every(Boolean);
    if (!matches)
      throw new LaunchSafetyError(
        'Claim configuration changed outside this launch'
      );
    if (action.kind === 'AIRDROP') {
      const expectedTotal = data.actions
        .filter((it) => it.kind === 'AIRDROP' && it.state === 'CONFIRMED')
        .reduce(
          (sum, it) =>
            sum + it.recipients.reduce((n, row) => n + row.amount, 0),
          0
        );
      if (Number(claim.total) !== expectedTotal)
        throw new LaunchSafetyError(
          'Claim supply changed before the planned airdrop'
        );
    }
  }
  async prepare(data: LaunchData, action: LaunchAction): Promise<string> {
    await this.verify(data, action);
    const [latest, pending, fee] = await Promise.all([
      this.nonce(data.signer, false),
      this.nonce(data.signer, true),
      rpcWithDeadline(this.provider.getFeeData())
    ]);
    if (latest !== pending)
      throw new LaunchSafetyError(
        'Signer has an untracked pending transaction'
      );
    if (
      fee.maxFeePerGas === null ||
      fee.maxPriorityFeePerGas === null ||
      fee.maxFeePerGas > this.config.maxFee
    )
      throw new LaunchSafetyError('Network gas fee exceeds configured budget');
    const request = {
      from: data.signer,
      to: data.proxy,
      data: encodeLaunchAction(data, action),
      value: BigInt(0),
      type: 2,
      chainId: data.chain_id,
      nonce: pending,
      maxFeePerGas: fee.maxFeePerGas,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas
    };
    const estimate = await rpcWithDeadline(this.provider.estimateGas(request));
    const gasLimit = (estimate * BigInt(120)) / BigInt(100);
    if (
      gasLimit > this.config.maxGas ||
      gasLimit * fee.maxFeePerGas > this.config.maxCost
    )
      throw new LaunchSafetyError('Transaction exceeds configured gas budget');
    if (
      (await rpcWithDeadline(this.provider.getBalance(data.signer))) <
      gasLimit * fee.maxFeePerGas
    )
      throw new LaunchSafetyError(
        'Operational signer has insufficient gas funds'
      );
    return Transaction.from({ ...request, from: undefined, gasLimit })
      .unsignedSerialized;
  }
}
