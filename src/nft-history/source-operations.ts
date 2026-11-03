import {
  Interface,
  TransactionReceipt,
  TransactionResponse,
  toBeHex,
  zeroPadValue
} from 'ethers';
import { NFT_HISTORY_IFACE } from '@/abis/nft_history';
import { NFTHistory } from '@/entities/INFTHistory';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { Log } from '@/ethereum-rpc/ethereum-rpc-types';
import { canonicalJson } from './canonical-json';
import {
  CLAIM_EVENT_IFACE,
  CLAIM_EXTENSIONS,
  ClaimEvent,
  claimMetadataUri,
  decodeClaimUpdate
} from './claim-events';
import {
  DEFERRED_CLAIM_EXTENSION,
  readHistoryClaim,
  VerifiedClaim
} from './claim-state';
import {
  HISTORY_CREATORS,
  HISTORY_SOURCE_IFACE,
  HistoryTransaction
} from './history-transactions';
import { decodeTokenUriUpdate } from './token-uri';

export interface SourceClaim {
  contract: string;
  claimId: string;
  tokenId: number;
  location: string;
}
export type HistorySourceOperation =
  | { kind: 'claim'; claim: SourceClaim }
  | { kind: 'mint'; row: NFTHistory }
  | {
      kind: 'edit';
      event: ClaimEvent;
      beforeFirstMint: boolean;
      previousUri?: string;
    };

export interface SourceHistoryReader {
  hasMint(contract: string, tokenId: number): Promise<boolean>;
  remainingMillis?: () => number;
  recordInitialization?: boolean;
}

interface MintLog {
  contract: string;
  tokenId: number;
  amount: bigint;
  operator: string;
  logIndex: number;
}

function creatorAddress(address: string): string | undefined {
  return HISTORY_CREATORS.find(
    (creator) => creator.toLowerCase() === address.toLowerCase()
  );
}

function mintLogs(receipt: TransactionReceipt): MintLog[] {
  const result: MintLog[] = [];
  for (const log of receipt.logs) {
    const contract = creatorAddress(log.address);
    if (!contract) continue;
    const parsed = HISTORY_SOURCE_IFACE.parseLog(log);
    if (
      !parsed ||
      !['TransferSingle', 'TransferBatch'].includes(parsed.name) ||
      BigInt(parsed.args.from) !== BigInt(0)
    )
      continue;
    const ids =
      parsed.name === 'TransferSingle'
        ? [parsed.args.id]
        : Array.from(parsed.args.ids);
    const amounts =
      parsed.name === 'TransferSingle'
        ? [parsed.args.value]
        : Array.from(parsed.args[4]);
    if (ids.length !== amounts.length) throw new Error('Malformed mint arrays');
    ids.forEach((id, index) => {
      const tokenId = Number(id);
      if (!Number.isSafeInteger(tokenId) || tokenId < 0 || tokenId > 2147483647)
        throw new Error('Mint token ID is outside the history storage range');
      result.push({
        contract,
        tokenId,
        amount: BigInt(String(amounts[index])),
        operator: String(parsed.args.operator),
        logIndex: log.index
      });
    });
  }
  return result;
}

async function verifySource(source: HistoryTransaction) {
  const rpc = getEthereumRpcClient();
  const [tx, receipt, block] = await Promise.all([
    rpc.getTransaction(source.hash),
    rpc.getTransactionReceipt(source.hash),
    rpc.getBlock(source.block)
  ]);
  if (
    !tx ||
    !receipt ||
    tx.blockNumber !== source.block ||
    tx.index !== source.transactionIndex ||
    receipt.blockHash !== block.hash ||
    tx.blockHash !== block.hash
  )
    throw new Error('History source transaction/block mismatch');
  for (const log of source.logs) {
    const actual = receipt.logs.find(
      (candidate) => candidate.index === log.logIndex
    );
    if (
      log.removed ||
      log.blockHash !== block.hash ||
      actual?.address.toLowerCase() !== log.address.toLowerCase() ||
      actual.data !== log.data ||
      canonicalJson(actual.topics) !== canonicalJson(log.topics)
    )
      throw new Error('History source receipt/log mismatch');
  }
  if (receipt.status !== 1) {
    if (source.logs.length)
      throw new Error('Failed transaction has discovered history logs');
    return null;
  }
  return { tx, receipt, block };
}

async function earlierClaimCalls(
  extension: string,
  contract: string,
  claimId: string,
  tx: TransactionResponse
): Promise<{ uri: string; initialized: boolean }[]> {
  const rpc = getEthereumRpcClient();
  const logs = await rpc.getLogs({
    address: extension,
    fromBlock: `0x${tx.blockNumber!.toString(16)}`,
    toBlock: `0x${tx.blockNumber!.toString(16)}`,
    topics: [
      [
        HISTORY_SOURCE_IFACE.getEvent('ClaimUpdated')!.topicHash,
        HISTORY_SOURCE_IFACE.getEvent(
          'ClaimInitialized(address,uint256,address)'
        )!.topicHash,
        HISTORY_SOURCE_IFACE.getEvent('ClaimInitialized(address,uint256)')!
          .topicHash
      ],
      zeroPadValue(contract, 32),
      zeroPadValue(toBeHex(BigInt(claimId)), 32)
    ]
  });
  const earlier = logs
    .filter((log) => log.transactionIndex < tx.index)
    .sort(
      (a, b) =>
        a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex
    );
  const calls = [];
  for (const log of earlier) {
    if (log.removed || log.blockHash !== tx.blockHash)
      throw new Error('Noncanonical preceding claim event');
    const previous = await rpc.getTransaction(log.transactionHash);
    if (
      !previous ||
      previous.blockHash !== tx.blockHash ||
      previous.index !== log.transactionIndex ||
      previous.to?.toLowerCase() !== extension.toLowerCase()
    )
      throw new Error(
        'Historical forwarded claim call requires execution calldata'
      );
    const parsed =
      NFT_HISTORY_IFACE.parseTransaction({ data: previous.data }) ??
      CLAIM_EVENT_IFACE.parseTransaction({ data: previous.data });
    if (
      !parsed ||
      !['initializeClaim', 'updateClaim', 'updateTokenURIParams'].includes(
        parsed.name
      )
    )
      throw new Error('Unsupported preceding claim calldata');
    if (
      String(parsed.args.creatorContractAddress).toLowerCase() !==
        contract.toLowerCase() ||
      String(parsed.args.instanceId ?? parsed.args.claimIndex) !== claimId
    )
      throw new Error('Preceding claim calldata/event mismatch');
    const parameters = parsed.args.claimParameters ?? parsed.args;
    calls.push({
      uri: claimMetadataUri(
        Number(parameters.storageProtocol),
        String(parameters.location)
      ),
      initialized: parsed.name === 'initializeClaim'
    });
  }
  return calls;
}

async function claimBeforeTransaction(
  extension: string,
  contract: string,
  claimId: string,
  tokenId: number,
  tx: TransactionResponse
): Promise<{ uri: string; total: string }> {
  const priorCalls = await earlierClaimCalls(extension, contract, claimId, tx);
  let prior: VerifiedClaim | undefined;
  // Initialization creates a new token/claim and rejects an existing claim.
  // Otherwise prior-block total is essential, even when the first mint occurs
  // long after initialization. Earlier mints in this block are checked below.
  if (!priorCalls.some((call) => call.initialized))
    prior = await readHistoryClaim(
      extension,
      contract,
      claimId,
      tx.blockNumber! - 1
    );
  if (prior && prior.tokenId !== tokenId)
    throw new Error('Historical claim/token mapping changed');
  const uri = priorCalls[priorCalls.length - 1]?.uri ?? prior?.uri;
  if (!uri) throw new Error('Missing historical claim initialization');
  const priorMints = await getEthereumRpcClient().getLogs({
    address: contract,
    fromBlock: `0x${tx.blockNumber!.toString(16)}`,
    toBlock: `0x${tx.blockNumber!.toString(16)}`,
    topics: [
      [
        HISTORY_SOURCE_IFACE.getEvent('TransferSingle')!.topicHash,
        HISTORY_SOURCE_IFACE.getEvent('TransferBatch')!.topicHash
      ],
      null,
      zeroPadValue('0x00', 32)
    ]
  });
  let mintedEarlier = false;
  for (const log of priorMints.filter(
    (entry) => entry.transactionIndex < tx.index
  )) {
    if (log.removed || log.blockHash !== tx.blockHash)
      throw new Error('Noncanonical preceding mint event');
    const parsed = HISTORY_SOURCE_IFACE.parseLog(log)!;
    const ids =
      parsed.name === 'TransferSingle'
        ? [parsed.args.id]
        : Array.from(parsed.args.ids);
    const amounts =
      parsed.name === 'TransferSingle'
        ? [parsed.args.value]
        : Array.from(parsed.args[4]);
    if (
      ids.some(
        (id, index) =>
          Number(id) === tokenId && BigInt(String(amounts[index])) > BigInt(0)
      )
    )
      mintedEarlier = true;
  }
  return { uri, total: mintedEarlier ? '1' : (prior?.total ?? '0') };
}

export function toSourceLog(log: TransactionReceipt['logs'][number]): Log {
  return {
    address: log.address,
    topics: Array.from(log.topics),
    data: log.data,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.index,
    removed: log.removed
  };
}

export async function decodeHistorySource(
  source: HistoryTransaction,
  reader: SourceHistoryReader
): Promise<HistorySourceOperation[]> {
  const verified = await verifySource(source);
  if (!verified) return [];
  const { tx, receipt } = verified;
  const parsed = NFT_HISTORY_IFACE.parseTransaction({ data: tx.data });
  const operations: HistorySourceOperation[] = [];
  const mints = mintLogs(receipt);
  if (
    new Set(
      mints.map((mint) => `${mint.contract.toLowerCase()}:${mint.tokenId}`)
    ).size > 100
  )
    throw new Error(
      'History source has too many token changes for one bounded transaction'
    );
  const claimed = new Map<string, VerifiedClaim>();
  async function claim(extension: string, contract: string, claimId: string) {
    const key = `${extension.toLowerCase()}:${contract.toLowerCase()}:${claimId}`;
    let state = claimed.get(key);
    if (!state) {
      state = await readHistoryClaim(
        extension,
        contract,
        claimId,
        source.block,
        reader.recordInitialization
      );
      claimed.set(key, state);
      if (state.tokenId >= 0)
        operations.push({
          kind: 'claim',
          claim: {
            contract,
            claimId,
            tokenId: state.tokenId,
            location: state.location
          }
        });
    }
    return state;
  }
  const context: SourceContext = {
    ...verified,
    source,
    parsed,
    operations,
    mints,
    claim,
    remainingMillis: reader.remainingMillis ?? (() => 900000)
  };
  await decodeSourceClaims(context, reader);
  await decodeSourceMints(context, reader);
  await decodeDirectUri(context);
  verifySupportedUriEvents(context);
  return operations;
}

type SourceContext = NonNullable<Awaited<ReturnType<typeof verifySource>>> & {
  source: HistoryTransaction;
  parsed: ReturnType<typeof NFT_HISTORY_IFACE.parseTransaction>;
  operations: HistorySourceOperation[];
  mints: MintLog[];
  remainingMillis: () => number;
  claim(
    extension: string,
    contract: string,
    claimId: string
  ): Promise<VerifiedClaim>;
};

function sourceClaimEvent(
  log: TransactionReceipt['logs'][number],
  source: HistoryTransaction
) {
  if (
    !CLAIM_EXTENSIONS.includes(log.address.toLowerCase()) &&
    !source.logs.some((entry) => entry.logIndex === log.index)
  )
    return null;
  const event = HISTORY_SOURCE_IFACE.parseLog(log);
  return event && ['ClaimInitialized', 'ClaimUpdated'].includes(event.name)
    ? event
    : null;
}

async function recordClaimInitialization(
  context: SourceContext,
  reader: SourceHistoryReader,
  extension: string,
  contract: string,
  claimId: string,
  state: VerifiedClaim
): Promise<void> {
  const { mints, tx, operations } = context;
  if (state.tokenId < 0) return;
  if (
    !mints.some(
      (mint) =>
        mint.contract === contract &&
        mint.tokenId === state.tokenId &&
        mint.operator.toLowerCase() === extension.toLowerCase()
    )
  )
    throw new Error(
      'Claim initialization has no matching creator token creation'
    );
  if (
    reader.recordInitialization &&
    !(await reader.hasMint(contract, state.tokenId))
  ) {
    operations.push({
      kind: 'mint',
      row: initializationRow(
        context,
        contract,
        state.tokenId,
        claimInitializationUri(tx, extension, contract, claimId)
      )
    });
  }
}

async function decodeSourceClaims(
  context: SourceContext,
  reader: SourceHistoryReader
): Promise<void> {
  const { receipt, claim, tx, operations } = context;
  for (const log of receipt.logs) {
    if (context.remainingMillis() < 90000)
      throw new Error('Source decode time budget exhausted');
    const event = sourceClaimEvent(log, context.source);
    if (!event) continue;
    const contract = creatorAddress(String(event.args.creatorContract));
    if (!contract) continue;
    const claimId = String(event.args.instanceId);
    const state = await claim(log.address, contract, claimId);
    if (event.name === 'ClaimInitialized') {
      await recordClaimInitialization(
        context,
        reader,
        log.address,
        contract,
        claimId,
        state
      );
    } else {
      const update = await decodeClaimUpdate(toSourceLog(log), () =>
        Promise.resolve([state.tokenId])
      );
      const before = await claimBeforeTransaction(
        log.address,
        contract,
        claimId,
        state.tokenId,
        tx
      );
      operations.push({
        kind: 'edit',
        event: update,
        beforeFirstMint: BigInt(before.total) === BigInt(0),
        previousUri: before.uri
      });
    }
  }
}

async function mintSourceUri(
  mint: MintLog,
  context: SourceContext
): Promise<string> {
  const { tx, parsed, mints, claim } = context;
  const directNew =
    tx.to?.toLowerCase() === mint.contract.toLowerCase() &&
    parsed?.name === 'mintBaseNew';
  const burnNew =
    parsed?.name === 'initializeBurnRedeem' &&
    tx.to?.toLowerCase() === mint.operator.toLowerCase() &&
    String(parsed.args.creatorContractAddress).toLowerCase() ===
      mint.contract.toLowerCase();
  if (directNew) {
    const uniqueIds = Array.from(
      new Set(
        mints
          .filter((entry) => entry.contract === mint.contract)
          .map((entry) => entry.tokenId)
      )
    );
    if (uniqueIds.length !== parsed.args.uris.length)
      throw new Error('Direct mint URI/token count mismatch');
    return String(parsed!.args.uris[uniqueIds.indexOf(mint.tokenId)]);
  } else if (burnNew) {
    const parameters = parsed.args.burnRedeemParameters;
    return claimMetadataUri(
      Number(parameters.storageProtocol),
      String(parameters.location)
    );
  } else {
    const claimId = await claimIdForMint(mint, context);
    const state = await claim(mint.operator, mint.contract, claimId);
    if (state.tokenId !== mint.tokenId)
      throw new Error('Mint/claim token mismatch');
    const before = await claimBeforeTransaction(
      mint.operator,
      mint.contract,
      claimId,
      mint.tokenId,
      tx
    );
    if (BigInt(before.total) !== BigInt(0))
      throw new Error(
        'Earlier Mint baseline is missing; audit its first mint before replay'
      );
    return before.uri;
  }
}

function createsToken(mint: MintLog, { tx, parsed }: SourceContext): boolean {
  if (parsed?.name === 'mintBaseNew')
    return tx.to?.toLowerCase() === mint.contract.toLowerCase();
  return (
    parsed?.name === 'initializeBurnRedeem' &&
    tx.to?.toLowerCase() === mint.operator.toLowerCase() &&
    String(parsed.args.creatorContractAddress).toLowerCase() ===
      mint.contract.toLowerCase()
  );
}

async function decodeSourceMints(
  context: SourceContext,
  reader: SourceHistoryReader
): Promise<void> {
  const { mints, tx, operations, source, block } = context;
  const seenMints = new Set<string>();
  for (const mint of mints) {
    const key = `${mint.contract.toLowerCase()}:${mint.tokenId}`;
    if (seenMints.has(key)) continue;
    if (context.remainingMillis() < 90000)
      throw new Error('Source decode time budget exhausted');
    if (await reader.hasMint(mint.contract, mint.tokenId)) {
      seenMints.add(key);
      continue;
    }
    if (
      !createsToken(mint, context) &&
      (reader.recordInitialization || mint.amount === BigInt(0))
    )
      continue;
    const uri = await mintSourceUri(mint, context);
    seenMints.add(key);
    if (reader.recordInitialization) {
      operations.push({
        kind: 'mint',
        row: initializationRow(context, mint.contract, mint.tokenId, uri)
      });
      continue;
    }
    operations.push({
      kind: 'mint',
      row: {
        contract: mint.contract,
        nft_id: mint.tokenId,
        uri,
        block: source.block,
        transaction_hash: tx.hash,
        transaction_date: new Date(block.timestamp * 1000),
        created_at: new Date(),
        description: { event: 'Mint', changes: [] }
      }
    });
  }
}

async function decodeDirectUri(context: SourceContext): Promise<void> {
  const { tx, parsed, operations } = context;
  if (tx.to && creatorAddress(tx.to) && parsed?.name === 'setTokenURI') {
    operations.push({
      kind: 'edit',
      event: await decodeTokenUriUpdate(
        tx.hash,
        creatorAddress(tx.to)!,
        Number(parsed.args.tokenId),
        String(parsed.args.uri_)
      ),
      beforeFirstMint: false
    });
  }
}

function verifySupportedUriEvents(context: SourceContext): void {
  const { source, operations, mints } = context;
  // A discovered URI event must not silently disappear behind an unsupported
  // function/forwarded call. The decoder needs exact execution calldata first.
  for (const log of source.logs) {
    const event = HISTORY_SOURCE_IFACE.parseLog(log);
    if (
      event?.name === 'URI' &&
      !mints.some(
        (mint) =>
          mint.contract.toLowerCase() === log.address.toLowerCase() &&
          mint.tokenId === Number(event.args.id)
      ) &&
      !operations.some(
        (operation) =>
          (operation.kind === 'mint' &&
            operation.row.contract.toLowerCase() ===
              log.address.toLowerCase() &&
            operation.row.nft_id === Number(event.args.id)) ||
          (operation.kind === 'edit' &&
            operation.event.contract.toLowerCase() ===
              log.address.toLowerCase() &&
            operation.event.nft_id === Number(event.args.id))
      )
    )
      throw new Error('Unsupported URI update; exact source calldata required');
  }
}

async function claimIdForMint(
  mint: MintLog,
  context: SourceContext
): Promise<string> {
  const { tx, parsed, source } = context;
  if (
    parsed &&
    tx.to?.toLowerCase() === mint.operator.toLowerCase() &&
    String(parsed.args.creatorContractAddress).toLowerCase() ===
      mint.contract.toLowerCase()
  ) {
    return String(parsed.args.instanceId ?? parsed.args.claimIndex);
  } else {
    if (!CLAIM_EXTENSIONS.includes(mint.operator.toLowerCase()))
      throw new Error('Unsupported mint extension; source calldata required');
    const raw = await getEthereumRpcClient().call(
      {
        to: mint.operator,
        data: CLAIM_EVENT_IFACE.encodeFunctionData('getClaimForToken', [
          mint.contract,
          mint.tokenId
        ])
      },
      source.block
    );
    if (
      !/^0x[0-9a-f]+$/i.test(raw) ||
      raw.length < 66 ||
      (raw.length - 2) % 64 !== 0
    )
      throw new Error('Malformed mint claim mapping');
    return BigInt(`0x${raw.slice(2, 66)}`).toString();
  }
}

const DEFERRED_INIT_IFACE = new Interface([
  'function initializeClaim(address creatorContractAddress,uint256 claimIndex,(uint32 totalMax,uint32 walletMax,uint48 startDate,uint48 endDate,uint8 storageProtocol,bytes32 merkleRoot,string location,uint256 cost,address paymentReceiver) claimParameters)'
]);

function claimInitializationUri(
  tx: TransactionResponse,
  extension: string,
  contract: string,
  claimId: string
): string {
  const parsed =
    NFT_HISTORY_IFACE.parseTransaction({ data: tx.data }) ??
    (extension.toLowerCase() === DEFERRED_CLAIM_EXTENSION
      ? DEFERRED_INIT_IFACE.parseTransaction({ data: tx.data })
      : null);
  if (
    tx.to?.toLowerCase() !== extension.toLowerCase() ||
    parsed?.name !== 'initializeClaim' ||
    String(parsed.args.creatorContractAddress).toLowerCase() !==
      contract.toLowerCase() ||
    String(parsed.args[1]) !== claimId
  )
    throw new Error('Initialization requires verified direct claim calldata');
  const params = parsed.args.claimParameters;
  return claimMetadataUri(
    Number(params.storageProtocol),
    String(params.location)
  );
}

function initializationRow(
  origin: NonNullable<Awaited<ReturnType<typeof verifySource>>>,
  contract: string,
  tokenId: number,
  uri: string
): NFTHistory {
  return {
    contract,
    nft_id: tokenId,
    uri,
    block: origin.block.number,
    transaction_hash: origin.tx.hash,
    transaction_date: new Date(origin.block.timestamp * 1000),
    created_at: new Date(),
    description: { event: 'Initialized', changes: [] }
  };
}

/** V3 sets the URI before assigning a creator token ID. Prove both ends. */
export async function decodeDeferredInitialization(
  initialization: HistoryTransaction,
  assignment: HistoryTransaction,
  contract: string,
  tokenId: number
): Promise<NFTHistory> {
  const [origin, later] = await Promise.all([
    verifySource(initialization),
    verifySource(assignment)
  ]);
  if (
    !origin ||
    !later ||
    initialization.block >= assignment.block ||
    later.tx.to?.toLowerCase() !== DEFERRED_CLAIM_EXTENSION
  )
    throw new Error('Invalid deferred claim assignment');

  const parsed = NFT_HISTORY_IFACE.parseTransaction({ data: later.tx.data });
  if (parsed?.name !== 'airdrop')
    throw new Error('Deferred assignment requires verified airdrop calldata');
  const claimId = String(parsed.args[1]);
  const logs = origin.receipt.logs.filter((log) => {
    if (log.address.toLowerCase() !== DEFERRED_CLAIM_EXTENSION) return false;
    const event = sourceClaimEvent(log, initialization);
    return (
      event?.name === 'ClaimInitialized' &&
      String(event.args.creatorContract).toLowerCase() ===
        contract.toLowerCase() &&
      String(event.args.instanceId) === claimId
    );
  });
  if (
    String(parsed.args.creatorContractAddress).toLowerCase() !==
      contract.toLowerCase() ||
    logs.length !== 1 ||
    !mintLogs(later.receipt).some(
      (mint) =>
        mint.contract.toLowerCase() === contract.toLowerCase() &&
        mint.tokenId === tokenId &&
        mint.operator.toLowerCase() === DEFERRED_CLAIM_EXTENSION &&
        mint.amount > BigInt(0)
    )
  )
    throw new Error('Deferred claim assignment does not match initialization');

  const uri = claimInitializationUri(
    origin.tx,
    DEFERRED_CLAIM_EXTENSION,
    contract,
    claimId
  );
  const [initial, before, assigned] = await Promise.all([
    readHistoryClaim(
      DEFERRED_CLAIM_EXTENSION,
      contract,
      claimId,
      initialization.block,
      true
    ),
    readHistoryClaim(
      DEFERRED_CLAIM_EXTENSION,
      contract,
      claimId,
      assignment.block - 1,
      true
    ),
    readHistoryClaim(
      DEFERRED_CLAIM_EXTENSION,
      contract,
      claimId,
      assignment.block
    )
  ]);
  if (
    initial.tokenId !== -1 ||
    initial.uri !== uri ||
    initial.total !== '0' ||
    before.tokenId !== -1 ||
    before.total !== '0' ||
    assigned.tokenId !== tokenId
  )
    throw new Error(
      'Historical deferred claim state does not match assignment'
    );
  return initializationRow(origin, contract, tokenId, uri);
}
