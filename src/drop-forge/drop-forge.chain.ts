import {
  RecoveryChain,
  RecoveryEvidence,
  verifyRecoveryMints
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
  LaunchRpcUnavailableError,
  LaunchSafetyError,
  RecoveryAttempt,
  assertPhaseScopedPlan
} from '@/drop-forge/drop-forge.types';
import { getEthereumRpcProvider } from '@/ethereum-rpc/ethereum-rpc-provider';
import {
  artistPaymentQuote,
  assertPaymentQuote,
  verifyPaymentTiming
} from '@/drop-forge/drop-forge.payment';
import {
  assertResearchTiming,
  isResearchAirdrop,
  researchAirdropAmount,
  verifyResearchSupply
} from '@/drop-forge/drop-forge.research';

export async function rpcWithDeadline<T>(request: Promise<T>): Promise<T> {
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
  inspectPayment?(
    data: LaunchData,
    action: LaunchAction,
    hash: string
  ): Promise<ChainReceipt | null>;
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
    if (!block?.hash)
      throw new LaunchRpcUnavailableError(
        'Receipt block is unavailable; transaction evidence and wallet reservation retained for retry'
      );
    if (block.hash !== receipt.blockHash) return null;
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
    if (action.kind === 'PAY_ARTIST') {
      verifyPaymentTiming(data, action, await this.now());
      const quote = await this.paymentQuote(data);
      assertPaymentQuote(action, quote, captureSupply);
      if (
        !this.config.maxArtistPayment ||
        BigInt(quote.amount_wei) > this.config.maxArtistPayment
      )
        throw new LaunchSafetyError(
          'Artist payment exceeds the configured payment limit'
        );
      return;
    }
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
        isError(error, 'CALL_EXCEPTION') &&
        (error.data === claimAbi.getError('ClaimNotInitialized')?.selector ||
          error.reason === 'Claim not initialized')
      ) {
        if (action.kind === 'INITIALIZE') return;
        throw new LaunchSafetyError(
          'Claim is not initialized; this action is not ready'
        );
      }
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
      : this.requiredPhase(data, action, claim);
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

  private requiredPhase(
    data: LaunchData,
    action: LaunchAction,
    claim: Result
  ): LaunchData['phases'][number] | undefined {
    if (action.kind !== 'UPDATE') return data.phases[action.phase];
    // A skipped earlier update must not prevent a later scheduled group from
    // advancing a compatible initialized claim while the earlier window is closed.
    const index = data.phases.findIndex(
      (phase) =>
        phase.start === Number(claim.startDate) &&
        phase.end === Number(claim.endDate) &&
        phase.root === claim.merkleRoot
    );
    if (index < 0 || index >= action.phase) return undefined;
    return data.phases[index];
  }

  private async verifyLateDelivery(
    data: LaunchData,
    action: LaunchAction,
    total: number,
    capture: boolean
  ): Promise<void> {
    if (
      action.kind !== 'AIRDROP' ||
      (await this.now()) < data.phases.at(-1)!.end
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
  private expectedAirdropSupply(
    action: LaunchAction,
    phaseActions: LaunchAction[]
  ): number {
    const update = phaseActions.find((it) => it.kind === 'UPDATE');
    const baseline =
      action.phase === 0
        ? 0
        : (update?.airdrop_baseline ?? update?.expected_supply);
    if (baseline === undefined || (update && update.state !== 'CONFIRMED'))
      throw new LaunchSafetyError(
        'Phase supply checkpoint is missing or unconfirmed'
      );
    return (
      baseline +
      phaseActions
        .filter((it) => it.kind === 'AIRDROP' && it.state === 'CONFIRMED')
        .reduce(
          (sum, it) =>
            sum + it.recipients.reduce((n, row) => n + row.amount, 0),
          0
        ) +
      phaseActions
        .filter((it) => it.kind === 'AIRDROP' && it.state !== 'CONFIRMED')
        .reduce((sum, it) => sum + (it.credited_tokens ?? 0), 0)
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
    let expected = action.expected_supply;
    if (action.kind === 'METADATA') return;
    if (action.kind === 'AIRDROP') {
      expected = this.expectedAirdropSupply(action, phaseActions);
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
    data: Pick<LaunchData, 'contract' | 'claim_id' | 'proxy'>,
    blockTag?: number
  ): Promise<Result | null> {
    try {
      const result = await rpcWithDeadline(
        this.provider.call({
          to: data.proxy,
          blockTag,
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
    const receipt = await this.receipt(hash);
    if (
      decoded.name === 'airdrop' &&
      receipt?.status === 1 &&
      receipt.confirmations >= this.config.confirmations
    ) {
      const mined = await rpcWithDeadline(
        this.provider.getTransactionReceipt(hash)
      );
      if (mined?.blockHash !== receipt.blockHash)
        throw new LaunchSafetyError(
          'Manual airdrop receipt changed during verification'
        );
      const recipients = (decoded.args[2] as string[]).map(
        (address, index) => ({
          address,
          amount: Number(decoded.args[3][index])
        })
      );
      verifyRecoveryMints(
        { contract, claim_id: claim },
        { recipients },
        mined.logs
      );
    }
    return { calldata: tx.data, receipt };
  }
  private async paymentQuote(
    data: LaunchData
  ): Promise<NonNullable<LaunchAction['payment']>> {
    const block = Math.max(
      0,
      (await rpcWithDeadline(this.provider.getBlockNumber())) -
        this.config.confirmations +
        1
    );
    const claim = await this.readClaim(data, block);
    if (
      !claim ||
      Number(claim.tokenId) !== data.claim_id ||
      Number(claim.totalMax) !== data.edition_size
    )
      throw new LaunchSafetyError(
        'Artist payment claim does not match the frozen edition'
      );
    return artistPaymentQuote(data, Number(claim.total), block);
  }
  async inspectPayment(
    data: LaunchData,
    action: LaunchAction,
    hash: string
  ): Promise<ChainReceipt | null> {
    if ((await this.now()) < data.phases.at(-1)!.end) return null;
    const quote = await this.paymentQuote(data);
    assertPaymentQuote(action, quote, true);
    const tx = await rpcWithDeadline(this.provider.getTransaction(hash));
    if (!tx) return null;
    if (
      tx.chainId !== BigInt(data.chain_id) ||
      tx.to?.toLowerCase() !== quote.recipient.toLowerCase() ||
      tx.value !== BigInt(quote.amount_wei) ||
      tx.data !== '0x'
    )
      throw new LaunchSafetyError(
        'Manual artist payment does not match the exact chain, recipient and amount'
      );
    return this.receipt(hash);
  }
  private async researchCompleted(
    data: LaunchData,
    action: LaunchAction
  ): Promise<{ total: number } | null> {
    assertResearchTiming(data, action, await this.now());
    if (
      data.actions.some(
        (it) =>
          it.kind === 'AIRDROP' &&
          !isResearchAirdrop(it) &&
          it.state !== 'CONFIRMED'
      )
    )
      throw new LaunchSafetyError(
        'Reconcile outstanding subscriber, artist and team deliveries before Research top-up'
      );
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
  private completedPhase(
    data: LaunchData,
    action: LaunchAction,
    claim: Result
  ): number | null {
    const observedPhase = data.phases.findIndex(
      (phase) =>
        Number(claim.startDate) === phase.start &&
        Number(claim.endDate) === phase.end &&
        claim.merkleRoot === phase.root
    );
    const phaseIndex = action.kind === 'UPDATE' ? action.phase : observedPhase;
    if (action.kind === 'METADATA' && phaseIndex >= 0)
      action.phase = phaseIndex;
    const phase = data.phases[phaseIndex];
    if (!phase)
      throw new LaunchSafetyError(
        'Initialized claim configuration is outside the frozen launch'
      );
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
    return phaseIndex;
  }
  async completed(
    data: LaunchData,
    action: LaunchAction
  ): Promise<{ total: number; metadata?: string } | null> {
    this.assertBinding(data);
    if (action.kind === 'PAY_ARTIST') {
      if ((await this.now()) < action.due) return null;
      const quote = await this.paymentQuote(data);
      if (BigInt(quote.amount_wei) !== BigInt(0)) return null;
      assertPaymentQuote(action, quote, true);
      return { total: 0 };
    }
    if (isResearchAirdrop(action)) return this.researchCompleted(data, action);
    if (!['INITIALIZE', 'UPDATE', 'METADATA'].includes(action.kind))
      return null;
    const head = await rpcWithDeadline(this.provider.getBlockNumber());
    const claim = await this.readClaim(
      data,
      Math.max(0, head - this.config.confirmations + 1)
    );
    if (!claim) return null;
    if (Number(claim.tokenId) !== data.claim_id)
      throw new LaunchSafetyError(
        'Initialized claim token does not match the prepared claim'
      );
    const phaseIndex = this.completedPhase(data, action, claim);
    if (phaseIndex === null) return null;
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
        ? {
            ...action,
            phase: phaseIndex,
            target_metadata: String(claim.location)
          }
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
      to: action.kind === 'PAY_ARTIST' ? action.payment!.recipient : data.proxy,
      data:
        action.kind === 'PAY_ARTIST' ? '0x' : encodeLaunchAction(data, action),
      value:
        action.kind === 'PAY_ARTIST'
          ? BigInt(action.payment!.amount_wei)
          : BigInt(0),
      type: 2,
      chainId: data.chain_id,
      nonce: pending,
      maxFeePerGas: fee.maxFeePerGas,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas
    };
    const estimate = await rpcWithDeadline(
      this.provider.estimateGas(request).catch((error: unknown) => {
        if (isError(error, 'INSUFFICIENT_FUNDS'))
          throw new LaunchSafetyError(
            'Operational signer has insufficient gas funds'
          );
        throw error;
      })
    );
    const gasLimit = (estimate * BigInt(120)) / BigInt(100);
    if (
      gasLimit > this.config.maxGas ||
      gasLimit * fee.maxFeePerGas > this.config.maxCost
    )
      throw new LaunchSafetyError('Transaction exceeds configured gas budget');
    if (
      (await rpcWithDeadline(this.provider.getBalance(data.signer))) <
      request.value + gasLimit * fee.maxFeePerGas
    )
      throw new LaunchSafetyError(
        'Operational signer has insufficient gas funds'
      );
    return Transaction.from({ ...request, from: undefined, gasLimit })
      .unsignedSerialized;
  }
}
