import {
  RecoveryChain,
  RecoveryEvidence
} from '@/drop-forge/drop-forge.recovery-chain';
import {
  Interface,
  isError,
  JsonRpcProvider,
  Transaction,
  ZeroAddress,
  Result
} from 'ethers';
import { DropForgeConfig } from '@/drop-forge/drop-forge.config';
import {
  LaunchAction,
  LaunchData,
  LaunchSafetyError,
  RecoveryAttempt,
  assertPhaseScopedPlan
} from '@/drop-forge/drop-forge.types';
import { getEthereumRpcProvider } from '@/ethereum-rpc/ethereum-rpc-provider';
import {
  assertResearchTiming,
  isResearchAirdrop,
  researchAirdropAmount,
  verifyResearchSupply
} from '@/drop-forge/drop-forge.research';

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
  inspectTransaction?(
    contract: string,
    claim: number,
    hash: string,
    sender?: string
  ): Promise<{ calldata: string; receipt: ChainReceipt | null }>;
  inspectRecovery?(hash: string): Promise<string>;
  prepareRecovery?(
    data: LaunchData,
    action: LaunchAction,
    operation: 'SPEED_UP' | 'CANCEL'
  ): Promise<string>;
  recoveryEvidence?(
    data: LaunchData,
    action: LaunchAction,
    attempt: RecoveryAttempt
  ): Promise<RecoveryEvidence | null>;
  completed?(
    data: LaunchData,
    action: LaunchAction
  ): Promise<{ total: number; metadata?: string } | null>;
}
export function encodeLaunchAction(
  data: LaunchData,
  action: LaunchAction
): string {
  if (action.kind === 'AIRDROP')
    return claimAbi.encodeFunctionData('airdrop', [
      data.contract,
      data.claim_id,
      (action.remaining_recipients ?? action.recipients).map(
        (row) => row.address
      ),
      (action.remaining_recipients ?? action.recipients).map(
        (row) => row.amount
      )
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
        action.target_metadata ?? data.metadata,
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
  async inspectRecovery(hash: string): Promise<string> {
    const tx = await rpcWithDeadline(this.provider.getTransaction(hash));
    if (!tx)
      throw new LaunchSafetyError(
        'Recovery transaction is not available; retain the hash and retry'
      );
    if (![0, 1, 2].includes(tx.type))
      throw new LaunchSafetyError('Unsupported recovery transaction type');
    const raw = Transaction.from({
      type: tx.type,
      to: tx.to,
      chainId: tx.chainId,
      nonce: tx.nonce,
      value: tx.value,
      data: tx.data,
      gasLimit: tx.gasLimit,
      gasPrice: tx.type < 2 ? tx.gasPrice : null,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      accessList: tx.accessList,
      signature: tx.signature
    }).serialized;
    if (Transaction.from(raw).hash !== hash)
      throw new LaunchSafetyError('RPC recovery transaction hash differs');
    return raw;
  }
  async prepareRecovery(
    data: LaunchData,
    action: LaunchAction,
    operation: 'SPEED_UP' | 'CANCEL'
  ): Promise<string> {
    this.assertBinding(data);
    return rpcWithDeadline(
      new RecoveryChain(this.config, this.provider).prepare(
        data,
        action,
        operation
      )
    );
  }
  async recoveryEvidence(
    data: LaunchData,
    action: LaunchAction,
    attempt: RecoveryAttempt
  ): Promise<RecoveryEvidence | null> {
    this.assertBinding(data);
    return rpcWithDeadline(
      new RecoveryChain(this.config, this.provider).evidence(
        data,
        action,
        attempt
      )
    );
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
  async verify(
    data: LaunchData,
    action: LaunchAction,
    captureSupply = false
  ): Promise<void> {
    assertPhaseScopedPlan(data);
    this.assertBinding(data);
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
    const phase = action.late_delivery
      ? data.phases.find(
          (it) =>
            it.start === Number(claim.startDate) &&
            it.end === Number(claim.endDate) &&
            it.root === claim.merkleRoot
        )
      : data.phases[action.kind === 'UPDATE' ? action.phase - 1 : action.phase];
    if (!phase)
      throw new LaunchSafetyError(
        'Current mint configuration is outside the frozen launch'
      );
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
    if (action.late_delivery) {
      await this.verifyLateDelivery(
        data,
        action,
        Number(claim.total),
        captureSupply
      );
      return;
    }
    await this.verifySupply(data, action, Number(claim.total), captureSupply);
  }

  private async verifyLateDelivery(
    data: LaunchData,
    action: LaunchAction,
    total: number,
    capture: boolean
  ): Promise<void> {
    if (
      action.kind !== 'AIRDROP' ||
      (await this.now()) < data.phases[data.phases.length - 1].end
    )
      throw new LaunchSafetyError(
        'Outstanding allocations can be delivered only after all minting closes'
      );
    if (isResearchAirdrop(action)) {
      verifyResearchSupply(data, action, total, await this.now(), capture);
      return;
    }
    const remaining = (action.remaining_recipients ?? action.recipients).reduce(
      (sum, row) => sum + row.amount,
      0
    );
    if (remaining <= 0 || total + remaining > data.edition_size)
      throw new LaunchSafetyError(
        'Outstanding allocations exceed remaining edition supply'
      );
    if (capture) action.expected_supply = total;
    if (action.expected_supply !== total)
      throw new LaunchSafetyError(
        'Claim supply changed before recovery delivery'
      );
  }
  private async verifySupply(
    data: LaunchData,
    action: LaunchAction,
    total: number,
    capture: boolean
  ): Promise<void> {
    if (isResearchAirdrop(action)) {
      verifyResearchSupply(data, action, total, await this.now(), capture);
      return;
    }
    const phaseActions = data.actions.filter((it) => it.phase === action.phase);
    const airdropAmount = (it: LaunchAction) =>
      it.recipients.reduce((sum, row) => sum + row.amount, 0);
    let expected = action.expected_supply;
    if (action.kind === 'METADATA') return;
    if (action.kind === 'AIRDROP') {
      const update = phaseActions.find((it) => it.kind === 'UPDATE');
      const baseline =
        action.phase === 0
          ? 0
          : (update?.airdrop_baseline ?? update?.expected_supply);
      if (baseline === undefined || (update && update.state !== 'CONFIRMED'))
        throw new LaunchSafetyError(
          'Phase supply checkpoint is missing or unconfirmed'
        );
      expected =
        baseline +
        phaseActions
          .filter((it) => it.kind === 'AIRDROP' && it.state === 'CONFIRMED')
          .reduce((sum, it) => sum + airdropAmount(it), 0) +
        phaseActions
          .filter((it) => it.kind === 'AIRDROP' && it.state !== 'CONFIRMED')
          .reduce((sum, it) => sum + (it.credited_tokens ?? 0), 0);
    }
    if (expected !== undefined && total !== expected)
      throw new LaunchSafetyError(
        'Claim supply changed before the planned transaction'
      );
    const remaining = phaseActions
      .filter((it) => it.kind === 'AIRDROP' && it.state !== 'CONFIRMED')
      .reduce(
        (sum, it) =>
          sum +
          (it.remaining_recipients ?? it.recipients).reduce(
            (n, row) => n + row.amount,
            0
          ),
        0
      );
    if (total + remaining > data.edition_size)
      throw new LaunchSafetyError(
        'Remaining phase airdrops exceed available edition supply'
      );
    // Capture real mints from the preceding phase once, while its window is
    // closed. Persist this checkpoint with the reserved unsigned transaction.
    if (capture || action.state === 'RESERVED') {
      const now = await this.now();
      if (
        now < action.due ||
        (action.kind === 'AIRDROP' && now >= data.phases[action.phase].start)
      )
        throw new LaunchSafetyError(
          'Phase transaction is outside its closed minting gap'
        );
    }
    if (capture) {
      action.expected_supply = total;
      if (action.kind === 'UPDATE')
        action.airdrop_baseline =
          total -
          phaseActions.reduce((sum, it) => sum + (it.credited_tokens ?? 0), 0);
    }
  }
  private assertBinding(data: LaunchData): void {
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
  }
  async readClaim(
    data: Pick<LaunchData, 'contract' | 'claim_id' | 'proxy'>
  ): Promise<Result | null> {
    try {
      const result = await rpcWithDeadline(
        this.provider.call({
          to: data.proxy,
          data: claimAbi.encodeFunctionData('getClaim', [
            data.contract,
            data.claim_id
          ])
        })
      );
      return claimAbi.decodeFunctionResult('getClaim', result)[0] as Result;
    } catch (error) {
      if (
        isError(error, 'CALL_EXCEPTION') &&
        (error.data === claimAbi.getError('ClaimNotInitialized')?.selector ||
          error.reason === 'Claim not initialized')
      )
        return null;
      throw error;
    }
  }
  async inspectTransaction(
    contract: string,
    claim: number,
    hash: string,
    sender?: string
  ): Promise<{ calldata: string; receipt: ChainReceipt | null }> {
    const tx = await rpcWithDeadline(this.provider.getTransaction(hash));
    if (!tx)
      throw new LaunchSafetyError(
        'Manual transaction is not yet available; retain its hash and retry'
      );
    const decoded = claimAbi.parseTransaction({
      data: tx.data,
      value: tx.value
    });
    if (
      tx.chainId !== BigInt(this.config.chainId) ||
      tx.to?.toLowerCase() !== this.config.proxy.toLowerCase() ||
      tx.value !== BigInt(0) ||
      !decoded ||
      !['initializeClaim', 'updateClaim', 'airdrop'].includes(decoded.name) ||
      decoded.args[0].toLowerCase() !== contract.toLowerCase() ||
      Number(decoded.args[1]) !== claim ||
      (sender && tx.from.toLowerCase() !== sender.toLowerCase())
    )
      throw new LaunchSafetyError(
        'Manual transaction does not match this wallet, chain, proxy and claim'
      );
    return { calldata: tx.data, receipt: await this.receipt(hash) };
  }
  private async researchCompleted(
    data: LaunchData,
    action: LaunchAction
  ): Promise<{ total: number } | null> {
    assertResearchTiming(data, action, await this.now());
    const configured = await this.completed(data, {
      ...action,
      kind: 'METADATA',
      target_metadata: data.metadata
    });
    if (!configured)
      throw new LaunchSafetyError(
        'Claim configuration changed before research reconciliation'
      );
    return researchAirdropAmount(configured.total, data.edition_size) === 0
      ? { total: configured.total }
      : null;
  }
  async completed(
    data: LaunchData,
    action: LaunchAction
  ): Promise<{ total: number; metadata?: string } | null> {
    this.assertBinding(data);
    if (isResearchAirdrop(action)) return this.researchCompleted(data, action);
    if (!['INITIALIZE', 'UPDATE', 'METADATA'].includes(action.kind))
      return null;
    const claim = await this.readClaim(data);
    if (!claim) return null;
    if (Number(claim.tokenId) !== data.claim_id)
      throw new LaunchSafetyError(
        'Initialized claim token does not match the prepared claim'
      );
    const phase = data.phases[action.phase];
    if (action.kind === 'METADATA') {
      if (claim.location !== action.target_metadata) return null;
    } else if (
      Number(claim.startDate) !== phase.start ||
      Number(claim.endDate) !== phase.end ||
      claim.merkleRoot !== phase.root
    ) {
      if (action.kind === 'INITIALIZE')
        throw new LaunchSafetyError(
          'Claim is already initialized with a different configuration; reconcile it rather than initialize again'
        );
      return null;
    }
    const params = [
      Number(claim.totalMax),
      Number(claim.walletMax),
      Number(claim.startDate),
      Number(claim.endDate),
      Number(claim.storageProtocol),
      claim.merkleRoot,
      claim.location,
      claim.cost.toString(),
      claim.paymentReceiver,
      claim.erc20,
      claim.signingAddress
    ];
    const observedAction =
      action.kind === 'INITIALIZE'
        ? { ...action, target_metadata: String(claim.location) }
        : action;
    const intended = claimAbi.parseTransaction({
      data: encodeLaunchAction(data, observedAction)
    })!;
    if (
      claimAbi.encodeFunctionData('updateClaim', [
        data.contract,
        data.claim_id,
        params
      ]) !==
      claimAbi.encodeFunctionData('updateClaim', [
        data.contract,
        data.claim_id,
        intended.args[2]
      ])
    )
      return null;
    return {
      total: Number(claim.total),
      ...(action.kind === 'INITIALIZE'
        ? { metadata: String(claim.location) }
        : {})
    };
  }
  async prepare(data: LaunchData, action: LaunchAction): Promise<string> {
    if (action.kind === 'METADATA') {
      const current = await this.readClaim(data);
      if (!current)
        throw new LaunchSafetyError(
          'Initialize the claim before updating metadata'
        );
      const phase = data.phases.findIndex(
        (it) =>
          it.start === Number(current.startDate) &&
          it.end === Number(current.endDate) &&
          it.root === current.merkleRoot
      );
      if (phase < 0)
        throw new LaunchSafetyError(
          'Current mint configuration is outside the launch plan'
        );
      action.phase = phase;
    }
    await this.verify(data, action, true);
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
