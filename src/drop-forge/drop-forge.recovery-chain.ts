import {
  Interface,
  JsonRpcProvider,
  Transaction,
  ZeroAddress,
  isError
} from 'ethers';
import { DropForgeConfig } from '@/drop-forge/drop-forge.config';
import {
  LaunchAction,
  LaunchData,
  LaunchRpcUnavailableError,
  LaunchSafetyError,
  RecoveryAttempt
} from '@/drop-forge/drop-forge.types';
import { ChainReceipt, claimAbi } from '@/drop-forge/drop-forge.chain';

const mintEvents = new Interface([
  'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
  'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)'
]);
export interface RecoveryEvidence {
  receipt: ChainReceipt;
  finalized: boolean;
  total: number;
}
export function validateRecoveryTransaction(
  data: LaunchData,
  action: LaunchAction,
  attempt: RecoveryAttempt
): Transaction {
  if (!attempt.signed_tx)
    throw new LaunchSafetyError('Recovery transaction has not been signed');
  const tx = Transaction.from(attempt.signed_tx);
  const original = Transaction.from(action.signed_tx!);
  const cancel = attempt.operation === 'CANCEL';
  const target = cancel ? data.signer : data.proxy;
  if (
    tx.hash !== attempt.hash ||
    tx.from?.toLowerCase() !== data.signer.toLowerCase() ||
    tx.chainId !== BigInt(data.chain_id) ||
    tx.nonce !== original.nonce ||
    tx.to?.toLowerCase() !== target.toLowerCase() ||
    tx.value !== BigInt(0) ||
    tx.data !== (cancel ? '0x' : original.data)
  )
    throw new LaunchSafetyError(
      'Recovery transaction differs from the reserved action and nonce'
    );
  return tx;
}
function allocationMap(
  rows: Array<{ address: string; amount: number }>
): Map<string, bigint> {
  const result = new Map<string, bigint>();
  for (const row of rows) {
    const key = row.address.toLowerCase();
    result.set(key, (result.get(key) ?? BigInt(0)) + BigInt(row.amount));
  }
  return result;
}
function accumulateMintLog(
  claimId: number,
  actual: Map<string, bigint>,
  parsed: NonNullable<ReturnType<typeof mintEvents.parseLog>>
): void {
  const ids: bigint[] =
    parsed.name === 'TransferSingle'
      ? [parsed.args.id]
      : Array.from(parsed.args[3]);
  const amounts: bigint[] =
    parsed.name === 'TransferSingle'
      ? [parsed.args.value]
      : Array.from(parsed.args[4]);
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== BigInt(claimId)) continue;
    const key = String(parsed.args.to).toLowerCase();
    actual.set(key, (actual.get(key) ?? BigInt(0)) + amounts[i]);
  }
}

function recoveryMintAllocations(
  data: Pick<LaunchData, 'contract' | 'claim_id'>,
  logs: ReadonlyArray<{
    address: string;
    topics: ReadonlyArray<string>;
    data: string;
  }>
): Map<string, bigint> {
  const actual = new Map<string, bigint>();
  for (const log of logs) {
    if (log.address.toLowerCase() !== data.contract.toLowerCase()) continue;
    let parsed;
    try {
      parsed = mintEvents.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (!parsed || parsed.args.from.toLowerCase() !== ZeroAddress.toLowerCase())
      continue;
    accumulateMintLog(data.claim_id, actual, parsed);
  }
  return actual;
}

export function verifyRecoveryMints(
  data: Pick<LaunchData, 'contract' | 'claim_id'>,
  action: Pick<LaunchAction, 'recipients' | 'remaining_recipients'>,
  logs: ReadonlyArray<{
    address: string;
    topics: ReadonlyArray<string>;
    data: string;
  }>
): void {
  const actual = recoveryMintAllocations(data, logs);
  const expected = allocationMap(
    action.remaining_recipients ?? action.recipients
  );
  if (
    actual.size !== expected.size ||
    Array.from(expected).some(
      ([address, amount]) => actual.get(address) !== amount
    )
  )
    throw new LaunchSafetyError(
      'Winning airdrop mint events do not match the exact outstanding allocations'
    );
}
export class RecoveryChain {
  constructor(
    private readonly config: DropForgeConfig,
    private readonly provider: JsonRpcProvider
  ) {}
  async prepare(
    data: LaunchData,
    action: LaunchAction,
    operation: 'SPEED_UP' | 'CANCEL'
  ): Promise<string> {
    const original = Transaction.from(action.signed_tx!);
    const fees = await this.provider.getFeeData();
    let maxFee = fees.maxFeePerGas ?? BigInt(0);
    let tip = fees.maxPriorityFeePerGas ?? BigInt(0);
    for (const attempt of action.recovery!.attempts) {
      if (!attempt.signed_tx) continue;
      const previous = Transaction.from(attempt.signed_tx);
      maxFee = bigger(
        maxFee,
        bump(previous.maxFeePerGas ?? previous.gasPrice ?? BigInt(0))
      );
      tip = bigger(
        tip,
        bump(previous.maxPriorityFeePerGas ?? previous.gasPrice ?? BigInt(0))
      );
    }
    maxFee = bigger(maxFee, tip);
    const cancel = operation === 'CANCEL';
    if (cancel && (await this.provider.getCode(data.signer)) !== '0x')
      throw new LaunchSafetyError(
        'Cancellation requires an operational wallet without delegated code'
      );
    const gasLimit = cancel ? BigInt(21000) : original.gasLimit;
    if (
      maxFee > this.config.maxFee ||
      gasLimit > this.config.maxGas ||
      gasLimit * maxFee > this.config.maxCost
    )
      throw new LaunchSafetyError(
        'Recovery replacement exceeds configured gas budget'
      );
    if ((await this.provider.getBalance(data.signer)) < gasLimit * maxFee)
      throw new LaunchSafetyError(
        'Operational signer has insufficient gas funds for recovery'
      );
    return Transaction.from({
      chainId: data.chain_id,
      type: 2,
      nonce: original.nonce,
      to: cancel ? data.signer : original.to,
      value: BigInt(0),
      data: cancel ? '0x' : original.data,
      gasLimit,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: tip
    }).unsignedSerialized;
  }
  async evidence(
    data: LaunchData,
    action: LaunchAction,
    attempt: RecoveryAttempt
  ): Promise<RecoveryEvidence | null> {
    validateRecoveryTransaction(data, action, attempt);
    const receipt = await this.provider.getTransactionReceipt(attempt.hash!);
    if (!receipt) return null;
    if (
      !(await this.receiptBlockMatches(receipt.blockNumber, receipt.blockHash))
    )
      return null;
    if (
      attempt.operation === 'CANCEL' &&
      (await this.provider.getCode(data.signer, receipt.blockNumber)) !== '0x'
    )
      throw new LaunchSafetyError(
        'Cancellation wallet has code; outcome requires manual investigation'
      );
    const finalized = await this.provider.getBlock('finalized');
    if (!finalized)
      throw new LaunchSafetyError(
        'Finalized chain evidence is unavailable; wallet remains reserved'
      );
    if (
      receipt.status === 1 &&
      attempt.operation !== 'CANCEL' &&
      action.kind === 'AIRDROP'
    )
      verifyRecoveryMints(data, action, receipt.logs);
    const total = await this.supplyAt(
      data,
      receipt.blockNumber,
      action.kind === 'INITIALIZE' &&
        (attempt.operation === 'CANCEL' || receipt.status === 0)
    );
    if (
      !(await this.receiptBlockMatches(receipt.blockNumber, receipt.blockHash))
    )
      return null;
    return {
      receipt: {
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        confirmations: await receipt.confirmations()
      },
      finalized: finalized.number >= receipt.blockNumber,
      total
    };
  }
  private async receiptBlockMatches(
    number: number,
    hash: string
  ): Promise<boolean> {
    const block = await this.provider.getBlock(number);
    if (!block?.hash)
      throw new LaunchRpcUnavailableError(
        'Recovery receipt block is unavailable; transaction evidence and wallet reservation retained for retry'
      );
    return block.hash === hash;
  }
  private async supplyAt(
    data: LaunchData,
    block: number,
    uninitializedAllowed: boolean
  ): Promise<number> {
    let result: string;
    try {
      result = await this.provider.call({
        to: data.proxy,
        data: claimAbi.encodeFunctionData('getClaim', [
          data.contract,
          data.claim_id
        ]),
        blockTag: block
      });
    } catch (error) {
      if (
        uninitializedAllowed &&
        isError(error, 'CALL_EXCEPTION') &&
        (error.data === claimAbi.getError('ClaimNotInitialized')!.selector ||
          error.reason === 'Claim not initialized')
      )
        return 0;
      throw error;
    }
    const claim = claimAbi.decodeFunctionResult('getClaim', result)[0];
    if (
      Number(claim.tokenId) !== data.claim_id ||
      Number(claim.totalMax) !== data.edition_size
    )
      throw new LaunchSafetyError(
        'Recovery claim supply binding differs from the frozen edition'
      );
    return Number(claim.total);
  }
}
function bigger(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
function bump(value: bigint): bigint {
  return (value * BigInt(125)) / BigInt(100) + BigInt(1);
}
