import { SEAPORT_IFACE } from '@/abis/seaport';
import {
  ACK_DEPLOYER,
  MANIFOLD,
  MEMELAB_CONTRACT,
  MEMELAB_ROYALTIES_ADDRESS,
  MEMES_DEPLOYER,
  NULL_ADDRESS,
  ROYALTIES_ADDRESS,
  TRANSACTIONS_TABLE,
  WETH_TOKEN_ADDRESS
} from '@/constants';
import { findTransactionsByHash } from '@/db';
import { Transaction } from '@/entities/ITransaction';
import { getClosestEthUsdPrice } from '@/ethPriceLoop/db.eth_price';
import { Logger } from '@/logging';
import {
  getNextgenNetwork,
  NEXTGEN_CORE_CONTRACT,
  NEXTGEN_ROYALTIES_ADDRESS
} from '@/nextgen/nextgen_constants';
import { get6529RpcProvider, getRpcProvider } from '@/rpc-provider';
import { equalIgnoreCase } from '@/strings';
import { ethers } from 'ethers';
import pLimit from 'p-limit';

const DEFAULT_TRANSACTION_VALUES_CONCURRENCY = 20;

const logger = Logger.get('TRANSACTION_VALUES');

const TRANSFER_EVENT =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const MINT_FROM_ADDRESS =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

const BLUR_EVENT =
  '0x7dc5c0699ac8dd5250cbe368a2fc3b4a2daadb120ad07f6cccea29f83482686e';

const OPENSEA_EVENT =
  '0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31';

const OPENSEA_MATCH_EVENT =
  '0x4b9f2d36e1b4c93de62cc077b00b1a91d84b6c31b4a14e012718dcca230689e7';

type RpcProvider = ReturnType<typeof getRpcProvider>;
type RpcTransaction = Awaited<ReturnType<RpcProvider['getTransaction']>>;
type RpcTransactionReceipt = Awaited<
  ReturnType<RpcProvider['getTransactionReceipt']>
>;
type RpcTransactionReceiptLike = NonNullable<RpcTransactionReceipt>;
type RpcInternalTransfersResponse = {
  transfers: Array<{
    hash: string;
    from: string;
    to?: string;
    value?: number;
  }>;
};

type TxRpcContext = {
  transaction: RpcTransaction | null;
  receipt: RpcTransactionReceipt | null;
};

type ResolveValueContext = {
  provider: RpcProvider;
  fallbackTraceProvider: RpcProvider | null;
  rowsByHash: Map<string, Transaction[]>;
  txRpcCache: Map<string, Promise<TxRpcContext>>;
  internalTransfersCache: Map<number, Promise<RpcInternalTransfersResponse>>;
};

type Erc20Transfer = {
  token: string;
  from: string;
  to: string;
  amountWei: bigint;
};

type ReceiptLog = {
  topics: readonly string[];
  data: string;
  address: string;
};

type ReceiptLike = {
  logs: readonly ReceiptLog[];
};

function isZeroAddress(address: string) {
  return /^0x0+$/.test(address);
}

function resolveLogAddress(address: string) {
  if (!address) {
    return address;
  }
  if (isZeroAddress(address)) {
    return NULL_ADDRESS;
  }
  const addressHex = '0x' + address.slice(-40);
  return ethers.getAddress(addressHex);
}

function resolveLogValue(data: string) {
  if (data === '0x') {
    return 0;
  }
  return Number.parseFloat(ethers.formatEther(data));
}

function getHashKey(hash: string): string {
  return hash.toLowerCase();
}

function getTokenUnits(row: Pick<Transaction, 'token_count'>): bigint {
  const parsed = Number(row.token_count);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return BigInt(1);
  }
  return BigInt(Math.floor(parsed));
}

function sumTokenUnits(rows: Pick<Transaction, 'token_count'>[]): bigint {
  return rows.reduce((acc, row) => acc + getTokenUnits(row), BigInt(0));
}

function prorateWei(
  totalWei: bigint,
  rowUnits: bigint,
  totalUnits: bigint
): bigint {
  if (totalWei <= BigInt(0) || rowUnits <= BigInt(0) || totalUnits <= BigInt(0))
    return BigInt(0);
  return (totalWei * rowUnits) / totalUnits;
}

function valueToWei(value: unknown): bigint {
  if (value === null || value === undefined) return BigInt(0);
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') {
    try {
      return BigInt(value);
    } catch {
      return BigInt(0);
    }
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return BigInt(0);
    }
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'object') {
    const maybeHex = Reflect.get(value, 'hex');
    if (typeof maybeHex === 'string') {
      try {
        return BigInt(maybeHex);
      } catch {
        return BigInt(0);
      }
    }
    const maybeUnderscoreHex = Reflect.get(value, '_hex');
    if (typeof maybeUnderscoreHex === 'string') {
      try {
        return BigInt(maybeUnderscoreHex);
      } catch {
        return BigInt(0);
      }
    }
    const maybeToString = Reflect.get(value, 'toString');
    if (
      typeof maybeToString === 'function' &&
      maybeToString !== Object.prototype.toString
    ) {
      try {
        const asString = maybeToString.call(value);
        if (typeof asString === 'string' && asString.length > 0) {
          return BigInt(asString);
        }
      } catch {
        return BigInt(0);
      }
    }
  }
  return BigInt(0);
}

function weiToEth(wei: bigint): number {
  if (wei <= BigInt(0)) return 0;
  return Number.parseFloat(ethers.formatEther(wei));
}

function isMemelabAckSpecialCase(t: Transaction): boolean {
  return (
    equalIgnoreCase(t.from_address, ACK_DEPLOYER) &&
    equalIgnoreCase(t.contract, MEMELAB_CONTRACT) &&
    t.token_id == 12
  );
}

function isMintLikeTransaction(t: Transaction): boolean {
  return (
    equalIgnoreCase(t.from_address, NULL_ADDRESS) ||
    equalIgnoreCase(t.from_address, MANIFOLD) ||
    isMemelabAckSpecialCase(t)
  );
}

function getRoyaltiesAddressForTransaction(t: Transaction): string {
  if (equalIgnoreCase(t.contract, MEMELAB_CONTRACT)) {
    return MEMELAB_ROYALTIES_ADDRESS;
  }
  if (equalIgnoreCase(t.contract, NEXTGEN_CORE_CONTRACT[getNextgenNetwork()])) {
    return NEXTGEN_ROYALTIES_ADDRESS;
  }
  return ROYALTIES_ADDRESS;
}

function buildRowsByHash(
  transactions: Transaction[]
): Map<string, Transaction[]> {
  const rowsByHash = new Map<string, Transaction[]>();
  for (const row of transactions) {
    const key = getHashKey(row.transaction);
    const rows = rowsByHash.get(key);
    if (rows) {
      rows.push(row);
    } else {
      rowsByHash.set(key, [row]);
    }
  }
  return rowsByHash;
}

function extractErc20Transfers(receipt: ReceiptLike): Erc20Transfer[] {
  const transfers: Erc20Transfer[] = [];
  for (const log of receipt.logs) {
    if (
      log.topics?.length !== 3 ||
      !equalIgnoreCase(log.topics[0], TRANSFER_EVENT)
    ) {
      continue;
    }
    try {
      const from = resolveLogAddress(log.topics[1]);
      const to = resolveLogAddress(log.topics[2]);
      const amountWei = valueToWei(log.data);
      transfers.push({
        token: log.address,
        from,
        to,
        amountWei
      });
    } catch (e: any) {
      logger.debug(
        `Error decoding ERC20 transfer in transaction values [ERROR: ${e.message}]`
      );
    }
  }
  return transfers;
}

async function getTxRpcContext(
  hash: string,
  provider: RpcProvider,
  txRpcCache: Map<string, Promise<TxRpcContext>>
): Promise<TxRpcContext> {
  const key = getHashKey(hash);
  const cached = txRpcCache.get(key);
  if (cached) return cached;

  const request = (async (): Promise<TxRpcContext> => {
    const transaction = await provider.getTransaction(hash);
    const receipt = transaction
      ? await provider.getTransactionReceipt(transaction.hash)
      : await provider.getTransactionReceipt(hash);
    if (!transaction || !receipt) {
      throw new Error(`Missing transaction context for ${hash}`);
    }
    return {
      transaction,
      receipt
    };
  })();

  txRpcCache.set(key, request);
  try {
    return await request;
  } catch (e: any) {
    txRpcCache.delete(key);
    logger.error(
      `Error fetching transaction context for ${hash} [ERROR: ${e.message}]`
    );
    throw e;
  }
}

async function getInternalTransfersForBlock(
  blockNumber: number,
  provider: RpcProvider,
  fallbackTraceProvider: RpcProvider | null,
  internalTransfersCache: Map<number, Promise<RpcInternalTransfersResponse>>
): Promise<RpcInternalTransfersResponse> {
  const cached = internalTransfersCache.get(blockNumber);
  if (cached) {
    return cached;
  }

  const request = (async () => {
    const blockHex = ethers.toBeHex(blockNumber);
    // This cache is scoped to one findTransactionValues() invocation, so a
    // transient trace_block miss here does not persist across future runs.
    try {
      const traces = await provider.send('trace_block', [blockHex]);
      return normalizeTraceInternalTransfers(traces);
    } catch (e: any) {
      if (fallbackTraceProvider) {
        logger.debug(
          `[INTERNAL_TRANSFERS] [BLOCK=${blockNumber}] [TRACE_BLOCK_FAILED] [TRYING_FALLBACK=true] [ERROR=${e.message}]`
        );
        try {
          const fallbackTraces = await fallbackTraceProvider.send(
            'trace_block',
            [blockHex]
          );
          return normalizeTraceInternalTransfers(fallbackTraces);
        } catch (fallbackError: any) {
          logger.error(
            `[INTERNAL_TRANSFERS] [BLOCK=${blockNumber}] [TRACE_BLOCK_FALLBACK_FAILED] [ERROR=${fallbackError.message}]`
          );
          return { transfers: [] };
        }
      }

      logger.error(
        `[INTERNAL_TRANSFERS] [BLOCK=${blockNumber}] [TRACE_BLOCK_FAILED] [ERROR=${e.message}]`
      );
      return { transfers: [] };
    }
  })();

  internalTransfersCache.set(blockNumber, request);
  return request;
}

function normalizeTraceInternalTransfers(
  traces: any
): RpcInternalTransfersResponse {
  if (!Array.isArray(traces)) {
    return { transfers: [] };
  }

  const transfers = traces
    .map((trace) => {
      if (trace?.error) {
        return null;
      }
      const valueWei = valueToWei(trace?.action?.value);
      if (valueWei <= BigInt(0)) {
        return null;
      }
      return {
        hash: trace?.transactionHash ?? '',
        from: trace?.action?.from ?? '',
        to: trace?.action?.to ?? undefined,
        value: weiToEth(valueWei)
      };
    })
    .filter((transfer): transfer is NonNullable<typeof transfer> => !!transfer)
    .filter((transfer) => transfer.hash && transfer.from && transfer.value > 0);

  return { transfers };
}

function getRowsForPairInTransaction(
  txRows: Transaction[],
  t: Transaction
): Transaction[] {
  return txRows.filter(
    (row) =>
      equalIgnoreCase(row.from_address, t.from_address) &&
      equalIgnoreCase(row.to_address, t.to_address) &&
      equalIgnoreCase(row.contract, t.contract)
  );
}

function sumErc20TransfersWei(
  transfers: Erc20Transfer[],
  predicate: (transfer: Erc20Transfer) => boolean
): bigint {
  return transfers
    .filter(predicate)
    .reduce((acc, transfer) => acc + transfer.amountWei, BigInt(0));
}

function getTransactionValuesProvider(
  network?: string | number,
  use6529Rpc = false
): RpcProvider {
  if (use6529Rpc) {
    return get6529RpcProvider();
  }
  const targetNetwork = network ?? 'eth-mainnet';
  return getRpcProvider(targetNetwork);
}

export const findTransactionValues = async (
  transactions: Transaction[],
  network?: string | number,
  use6529Rpc = false
) => {
  const provider = getTransactionValuesProvider(network, use6529Rpc);
  const fallbackTraceProvider = use6529Rpc
    ? getRpcProvider(network ?? 'eth-mainnet')
    : null;

  const concurrency = DEFAULT_TRANSACTION_VALUES_CONCURRENCY;
  logger.info(
    `[PROCESSING VALUES FOR ${transactions.length} TRANSACTIONS] [CONCURRENCY=${concurrency}]`
  );

  const context: ResolveValueContext = {
    provider,
    fallbackTraceProvider,
    rowsByHash: buildRowsByHash(transactions),
    txRpcCache: new Map<string, Promise<TxRpcContext>>(),
    internalTransfersCache: new Map<
      number,
      Promise<RpcInternalTransfersResponse>
    >()
  };

  const limiter = pLimit(concurrency);
  const transactionsWithValues = await Promise.all(
    transactions.map((t) => limiter(() => resolveValue(t, context)))
  );

  logger.info(
    `[PROCESSED ${transactionsWithValues.length} TRANSACTION VALUES]`
  );

  return transactionsWithValues;
};

type TransactionRowGroups = {
  rowUnits: bigint;
  txUnits: bigint;
  pairUnits: bigint;
  mintUnits: bigint;
};

type FallbackValueResolution = {
  value: number;
  royalties: number;
};

function buildTransactionRowGroups(
  t: Transaction,
  rowsByHash: Map<string, Transaction[]>
): TransactionRowGroups {
  const txRows = rowsByHash.get(getHashKey(t.transaction)) ?? [t];
  const pairRows = getRowsForPairInTransaction(txRows, t);
  const mintRows = txRows.filter(isMintLikeTransaction);
  return {
    rowUnits: getTokenUnits(t),
    txUnits: sumTokenUnits(txRows),
    pairUnits: sumTokenUnits(pairRows),
    mintUnits: sumTokenUnits(mintRows)
  };
}

function applyBaseValueFields(
  t: Transaction,
  transactionValueWei: bigint,
  rowUnits: bigint,
  txUnits: bigint
) {
  t.value = weiToEth(prorateWei(transactionValueWei, rowUnits, txUnits));
  t.royalties = 0;
  t.primary_proceeds = 0;
  t.gas = 0;
  t.gas_price = 0;
  t.gas_price_gwei = 0;
  t.gas_gwei = 0;
}

function getTransferLogCountForRecipient(
  receipt: ReceiptLike,
  recipient: string
): number {
  const count = receipt.logs.filter((log) => {
    const toTopic = log.topics?.[2];
    return (
      equalIgnoreCase(log.topics?.[0], TRANSFER_EVENT) &&
      !!toTopic &&
      equalIgnoreCase(resolveLogAddress(toTopic), recipient)
    );
  }).length;
  return count || 1;
}

function getGasPriceWei(
  receipt: RpcTransactionReceiptLike,
  transaction: RpcTransaction | null
): bigint {
  const candidates = [
    Reflect.get(receipt, 'effectiveGasPrice'),
    Reflect.get(receipt, 'gasPrice'),
    transaction?.gasPrice
  ];
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined) {
      return valueToWei(candidate);
    }
  }
  return BigInt(0);
}

function applyGasValues(
  t: Transaction,
  receipt: RpcTransactionReceiptLike,
  transaction: RpcTransaction | null,
  logCount: number
) {
  if (!receipt.gasUsed) {
    return;
  }
  const gasUnits = Number(receipt.gasUsed);
  const gasPriceWei = getGasPriceWei(receipt, transaction);
  const gasPrice = Number.parseFloat(ethers.formatEther(gasPriceWei));
  const gasPriceGwei =
    Math.round(gasPrice * 1000000000 * 100000000) / 100000000;
  const gas = Math.round(gasUnits * gasPrice * 100000000) / 100000000;

  t.gas_gwei = gasUnits;
  t.gas_price = gasPrice;
  t.gas_price_gwei = gasPriceGwei;
  t.gas = gas / logCount;
}

async function resolveFallbackValueAndRoyalties(
  t: Transaction,
  receipt: ReceiptLike,
  royaltiesAddress: string,
  rowUnits: bigint,
  pairUnits: bigint,
  logCount: number
): Promise<FallbackValueResolution> {
  let totalValue = 0;
  let totalRoyalties = 0;

  const erc20Transfers = extractErc20Transfers(receipt);
  const buyerToSellerWethWei = sumErc20TransfersWei(
    erc20Transfers,
    (transfer) =>
      equalIgnoreCase(transfer.token, WETH_TOKEN_ADDRESS) &&
      equalIgnoreCase(transfer.from, t.to_address) &&
      equalIgnoreCase(transfer.to, t.from_address)
  );
  if (buyerToSellerWethWei > BigInt(0)) {
    totalValue = weiToEth(
      prorateWei(buyerToSellerWethWei, rowUnits, pairUnits)
    );
  }

  const buyerToRoyaltiesWethWei = sumErc20TransfersWei(
    erc20Transfers,
    (transfer) =>
      equalIgnoreCase(transfer.token, WETH_TOKEN_ADDRESS) &&
      equalIgnoreCase(transfer.from, t.to_address) &&
      equalIgnoreCase(transfer.to, royaltiesAddress)
  );
  if (buyerToRoyaltiesWethWei > BigInt(0)) {
    totalRoyalties = weiToEth(
      prorateWei(buyerToRoyaltiesWethWei, rowUnits, pairUnits)
    );
  }

  for (const log of receipt.logs) {
    if (isBlurEvent(log) && !totalRoyalties) {
      const royaltiesResponse = await parseBlurLog(log);
      if (
        royaltiesResponse &&
        equalIgnoreCase(royaltiesResponse.feeRecipient, royaltiesAddress)
      ) {
        const parsedRate = Number(royaltiesResponse.feeRate);
        const parsedRatePercentage = parsedRate / 100;
        const royaltiesBaseValue = totalValue || t.value;
        totalRoyalties = royaltiesBaseValue * (parsedRatePercentage / 100);
      }
      continue;
    }

    if (totalValue || !equalIgnoreCase(log.topics?.[0], TRANSFER_EVENT)) {
      continue;
    }

    try {
      if (
        equalIgnoreCase(log.address, WETH_TOKEN_ADDRESS) &&
        log.topics?.[1] &&
        log.topics?.[2]
      ) {
        const from = resolveLogAddress(log.topics[1]);
        const to = resolveLogAddress(log.topics[2]);
        const value = resolveLogValue(log.data) / logCount;
        if (
          equalIgnoreCase(from, t.to_address) &&
          (equalIgnoreCase(to, t.from_address) ||
            equalIgnoreCase(to, royaltiesAddress))
        ) {
          totalValue += value;
        }
      } else if (equalIgnoreCase(log.topics?.[1], MINT_FROM_ADDRESS)) {
        totalValue = t.value / logCount;
      }
    } catch (e) {
      logger.error(
        `Error adding royalties for transaction ${t.transaction}`,
        e
      );
    }
  }

  return {
    value: totalValue,
    royalties: totalRoyalties
  };
}

async function applyReceiptValueAndRoyalties(
  t: Transaction,
  receipt: ReceiptLike,
  royaltiesAddress: string,
  rowUnits: bigint,
  pairUnits: bigint,
  logCount: number
) {
  const attributedRow = attributeRowFromSeaportTx(receipt, t, royaltiesAddress);
  if (attributedRow) {
    t.royalties = attributedRow.royalties;
    t.value = attributedRow.value;
    return;
  }

  const resolved = await resolveFallbackValueAndRoyalties(
    t,
    receipt,
    royaltiesAddress,
    rowUnits,
    pairUnits,
    logCount
  );
  if (resolved.value) {
    t.value = resolved.value;
  }
  if (resolved.royalties) {
    t.royalties = resolved.royalties;
  }
}

async function applyMintPrimaryProceeds(
  t: Transaction,
  context: ResolveValueContext,
  rowUnits: bigint,
  mintUnits: bigint
) {
  try {
    const internalTransfers = await getInternalTransfersForBlock(
      t.block,
      context.provider,
      context.fallbackTraceProvider,
      context.internalTransfersCache
    );
    const txInternalTransfers = internalTransfers.transfers.filter((transfer) =>
      equalIgnoreCase(transfer.hash, t.transaction)
    );

    const proceedsToMemesDeployer = txInternalTransfers.filter(
      (transfer) => transfer.to && equalIgnoreCase(transfer.to, MEMES_DEPLOYER)
    );
    const primaryTransfers =
      proceedsToMemesDeployer.length > 0
        ? proceedsToMemesDeployer
        : txInternalTransfers.filter(
            (transfer) =>
              equalIgnoreCase(transfer.from, t.to_address) ||
              equalIgnoreCase(transfer.from, MANIFOLD) ||
              (transfer.to && equalIgnoreCase(transfer.to, MEMES_DEPLOYER))
          );

    const primaryProceedsTxTotal = primaryTransfers.reduce(
      (acc, transfer) => acc + (transfer.value ?? 0),
      0
    );

    if (primaryProceedsTxTotal > 0) {
      t.primary_proceeds =
        (primaryProceedsTxTotal * Number(rowUnits)) / Number(mintUnits);
    }
  } catch (e: any) {
    logger.error(
      `Error fetching primary proceeds for transaction ${t.transaction}`,
      e
    );
  }
}

function roundTo8(value: number): number {
  return Number.parseFloat((value || 0).toFixed(8));
}

function roundTransactionValues(t: Transaction) {
  t.value = roundTo8(t.value);
  t.royalties = roundTo8(t.royalties);
  t.primary_proceeds = roundTo8(t.primary_proceeds);
  t.gas = roundTo8(t.gas);
  t.gas_price = roundTo8(t.gas_price);
  t.gas_price_gwei = roundTo8(t.gas_price_gwei);
  t.gas_gwei = roundTo8(t.gas_gwei);
}

async function applyUsdValues(t: Transaction) {
  const ethPrice = await getClosestEthUsdPrice(new Date(t.transaction_date));
  t.eth_price_usd = ethPrice;
  t.value_usd = t.value * ethPrice;
  t.gas_usd = t.gas * ethPrice;
}

async function resolveValue(t: Transaction, context: ResolveValueContext) {
  const groups = buildTransactionRowGroups(t, context.rowsByHash);
  const { transaction, receipt } = await getTxRpcContext(
    t.transaction,
    context.provider,
    context.txRpcCache
  );
  const transactionValueWei = transaction
    ? valueToWei(transaction.value)
    : BigInt(0);

  applyBaseValueFields(t, transactionValueWei, groups.rowUnits, groups.txUnits);
  const royaltiesAddress = getRoyaltiesAddressForTransaction(t);

  if (receipt) {
    const logCount = getTransferLogCountForRecipient(receipt, t.to_address);
    applyGasValues(t, receipt, transaction, logCount);
    await applyReceiptValueAndRoyalties(
      t,
      receipt,
      royaltiesAddress,
      groups.rowUnits,
      groups.pairUnits,
      logCount
    );
  }

  if (isMintLikeTransaction(t)) {
    if (transactionValueWei > BigInt(0)) {
      const grossMintWei = prorateWei(
        transactionValueWei,
        groups.rowUnits,
        groups.mintUnits
      );
      t.value = weiToEth(grossMintWei);
    }

    await applyMintPrimaryProceeds(
      t,
      context,
      groups.rowUnits,
      groups.mintUnits
    );

    if (!t.primary_proceeds && t.value) {
      t.primary_proceeds = t.value;
    }
  }

  roundTransactionValues(t);
  await applyUsdValues(t);
  return t;
}

const isSeaportEvent = (receipt: {
  logs: readonly { topics: readonly string[] }[];
}) => {
  return receipt.logs.some((log) =>
    equalIgnoreCase(log.topics[0], OPENSEA_EVENT)
  );
};

const parseSeaportLog = async (
  t: Transaction,
  royaltiesAddress: string,
  log: ReceiptLog
) => {
  let seaResult;
  try {
    seaResult = SEAPORT_IFACE.parseLog(log)!;
  } catch (e: any) {
    logger.debug(
      `SEAPORT PARSE ERROR for transaction ${t.transaction} [ERROR: ${e.message}]`
    );
    return null;
  }

  // flow 1 - offerer is from_address
  if (equalIgnoreCase(seaResult.args.offerer, t.from_address)) {
    const offer = seaResult.args.offer[0];

    // validate token
    if (
      !(
        equalIgnoreCase(offer.token, t.contract) &&
        Number(offer.identifier) === Number(t.token_id)
      )
    ) {
      return {
        contract: t.contract,
        tokenId: t.token_id,
        royaltiesAmount: 0,
        totalAmount: 0
      };
    }

    // validate from consideration
    const fromConsideration = seaResult.args.consideration.find((c: any) =>
      equalIgnoreCase(c.recipient, t.from_address)
    );
    if (!fromConsideration) {
      return {
        contract: t.contract,
        tokenId: t.token_id,
        royaltiesAmount: 0,
        totalAmount: 0
      };
    }

    const totalAmount = seaResult.args.consideration.reduce(
      (acc: number, c: any) =>
        acc + Number.parseFloat(ethers.formatEther(c.amount)),
      0
    );

    const royalties = seaResult.args.consideration.find((c: any) =>
      equalIgnoreCase(c.recipient, royaltiesAddress)
    );

    return {
      orderHash: seaResult.args.orderHash,
      contract: t.contract,
      tokenId: t.token_id,
      royaltiesAmount: royalties
        ? Number.parseFloat(ethers.formatEther(royalties.amount))
        : 0,
      totalAmount: totalAmount
    };
  }

  // flow 2 - offerer is to_address
  if (equalIgnoreCase(seaResult.args.offerer, t.to_address)) {
    const offer = seaResult.args.offer[0];

    // validate token
    const tokenConsideration = seaResult.args.consideration.find(
      (c: any) =>
        equalIgnoreCase(c.token, t.contract) &&
        Number(c.identifier) === Number(t.token_id)
    );
    if (!tokenConsideration) {
      return {
        contract: t.contract,
        tokenId: t.token_id,
        royaltiesAmount: 0,
        totalAmount: 0
      };
    }

    const royalties = seaResult.args.consideration.find((c: any) =>
      equalIgnoreCase(c.recipient, royaltiesAddress)
    );

    const totalAmount = Number.parseFloat(ethers.formatEther(offer.amount));

    return {
      orderHash: seaResult.args.orderHash,
      contract: t.contract,
      tokenId: t.token_id,
      royaltiesAmount: royalties
        ? Number.parseFloat(ethers.formatEther(royalties.amount))
        : 0,
      totalAmount: totalAmount
    };
  }
};

const isBlurEvent = (log: { topics: readonly string[] }) => {
  return equalIgnoreCase(log.topics[0], BLUR_EVENT);
};

const parseBlurLog = async (log: { data: string }) => {
  try {
    const data = log.data;
    const dataWithoutPrefix = data.startsWith('0x') ? data.slice(2) : data;
    const packedFeeHex = '0x' + dataWithoutPrefix.slice(-64);

    const value = BigInt(packedFeeHex);

    // Use bit shift to calculate 2^160
    const twoTo160 = BigInt(1) << BigInt(160);
    const recipientMask = twoTo160 - BigInt(1);

    const feeRate = value / twoTo160;
    const feeRecipientBN = value & recipientMask;

    let feeRecipient = feeRecipientBN.toString(16);
    feeRecipient = feeRecipient.padStart(40, '0');
    feeRecipient = '0x' + feeRecipient;

    return { feeRate, feeRecipient };
  } catch (error) {
    logger.error(`Error unpacking fee: ${JSON.stringify(error)}`);
    return null;
  }
};

// HELPER FUNCTION FOR DEBUGGING VALUES USING TRX HASHES FROM DB
export const debugValues = async () => {
  const provider = getTransactionValuesProvider();
  const fallbackTraceProvider = null;

  // SAMPLE TRX HASHES
  const transactions = [
    // '0x3a1738756cb325a3e8ff13b39471bae5c6d82dcbfdb9a7c8fe1de59580c6577c'
    '0x0b03eda60f61da124fa0dbb9d669cb9c9a8bf78b7ada06706b9487fbbe9088e1'
    // '0x68896a9377b8bb04c50d6952006317f3c85971f80a2def180853798c4ab5556b'
    // '0xccec0c96bf05130b09906bd13045a21aa2eef2aa78849cd14600d433dc1f7e26'
    // '0xf95a5c52cef7473a32254e9442fb00e38116345b86695010969b9db73c942223'
    // '0xb956e461bc029f1c4c059ef5f23b94e2f8cf0727229d2d236390cddfa667641f'
    // '0x9d485f52ab94d16784cb6b9978ccdbbe31b02d5e02ecc94e19a2da3b32bee056'
    // '0x73accf9e1c0976c7287fde1a76de277399856209ddb986889c312cfe79430867'
    // '0xd9af693467a00fcfb912d117daf9fb3361eb77541e83e47798007a512efd2ba2'
    // '0x49ac53f0774bba27a0f6d7b95c87aa43a061a3f5d0b55cca7b69957cc57e5edb'
    // '0x9e1275572c68387ccfaee87b0476cfb7c86f6a843e4b317c7672f92eac5c1418'
    // '0x1548b69496e5bb2afcc426f5fe874a86fa6cc7daae0e5e46474dbb885a2556fc'
    // '0x06da80ac9aa3f2848ff2ba1c9bd62a129495eef959609b5e66135b934858f73d'
    // '0xa3f251e406d2cb8279b4d2fb852c20b55d9dec8ac8ca50e98765b398577fecbb'
    // '0xb93a6b6241394a07ba3c3904f48e924c3ab087356b8727de7330f83e34560cbb'
    // '0x2fc2002bb5fd89f30e4e456bc9aa1ae73d353e213084906c656c9a2dfa42df78'
    // '0xfca058600347480cb759890182328dc11034e5c135b7d51f2d67dbc9774e674f'
    // '0xf7982454b13c4837058f8efadc0794239b281d2d473817d3edfbce2520114e44'
    // '0x3a79990d01b87d77741227a81db0201b31d2e711aefff943c086d2bbc90a0605'
    // '0x0010dcbac1dcdebd2f4186342dda88ec8889bf0ffb9445b7598ec0172d671b07',
    // '0x4144495f6932b53d48469b76876a82ffa0172d69dc9fc69f2120444b6df2a1b7'
    // '0xdf73c5f14da545c5da2d86e9f9b9733541a003609374c456d7c3badad234b16a',
    // '0x308577a5a108cc64633513215302ad1400b1018a593128fe53552216adc8fc6c',
    // '0xe7d7748edd1228ca665e40e5b9792e5ef0a7a16606c18ef11851db435f2b43af'
    // '0x00027d17a0f851a56dca8c469fd70b0d23dca2e3d2b4ebdad2f7e09ccb909405'
  ];

  await Promise.all(
    transactions.map(async (transactionHash) => {
      const tr = await findTransactionsByHash(TRANSACTIONS_TABLE, [
        transactionHash
      ]);
      const context: ResolveValueContext = {
        provider,
        fallbackTraceProvider,
        rowsByHash: buildRowsByHash(tr),
        txRpcCache: new Map<string, Promise<TxRpcContext>>(),
        internalTransfersCache: new Map<
          number,
          Promise<RpcInternalTransfersResponse>
        >()
      };

      let totalValue = 0;
      let totalRoyalties = 0;
      let totalPrimaryProceeds = 0;

      for (const t of tr) {
        const parsedTransaction = await resolveValue(t, context);
        logger.info({
          token_id: parsedTransaction.token_id,
          from: parsedTransaction.from_address,
          to: parsedTransaction.to_address,
          value: parsedTransaction.value,
          primaryProceeds: parsedTransaction.primary_proceeds,
          royalties: parsedTransaction.royalties
        });
        totalValue += parsedTransaction.value;
        totalPrimaryProceeds += parsedTransaction.primary_proceeds;
        totalRoyalties += parsedTransaction.royalties;
      }
      logger.info({
        transactionHash: transactionHash,
        totalValue: totalValue,
        totalPrimaryProceeds: totalPrimaryProceeds,
        totalRoyalties: totalRoyalties
      });
    })
  );
};

type RowAttribution = {
  value: number; // the slice of the sale value for THIS row
  royalties: number; // royalties to the target recipient for THIS row
  currency: { itemType: number; token: string } | null; // 0x0.. for ETH
  orderHash?: string;
};

const ItemType = {
  NATIVE: 0,
  ERC20: 1,
  ERC721: 2,
  ERC1155: 3,
  ERC721_WITH_CRITERIA: 4,
  ERC1155_WITH_CRITERIA: 5
} as const;

const IFACE = new ethers.Interface([
  // Seaport v1.6 events
  'event OrderFulfilled(bytes32 orderHash,address offerer,address zone,address recipient,(uint8 itemType,address token,uint256 identifier,uint256 amount)[] offer,(uint8 itemType,address token,uint256 identifier,uint256 amount,address recipient)[] consideration)',
  // ERC721 & ERC1155 Transfer events
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
  'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
  'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)'
]);

const isNftItemType = (t: number) =>
  t === ItemType.ERC721 ||
  t === ItemType.ERC1155 ||
  t === ItemType.ERC721_WITH_CRITERIA ||
  t === ItemType.ERC1155_WITH_CRITERIA;

const isCurrencyItemType = (t: number) =>
  t === ItemType.NATIVE || t === ItemType.ERC20;

/**
 * Parse ONE tx and attribute the exact value + royalties for ONE row (from,to,contract,tokenId).
 *
 * - `receipt` must be the full transaction receipt (we need all logs).
 * - `row` is your table row key.
 * - `royaltiesAddress` is the specific royalty recipient you're tracking (creator wallet/forwarder).
 * - `seaportAddress` is Seaport v1.6 address for the chain you’re on.
 */
function attributeRowFromSeaportTx(
  receipt: ReceiptLike,
  row: Transaction,
  royaltiesAddress: string
): RowAttribution | null {
  // 1) Gather all NFT Transfers in this tx
  type NftEdge = {
    from: string;
    to: string;
    contract: string;
    tokenId: string;
    amount: bigint;
  };
  const nftEdges: NftEdge[] = [];

  for (const lg of receipt.logs) {
    // ERC721 Transfer
    if (
      lg.topics.length === 4 &&
      lg.topics[0] === IFACE.getEvent('Transfer')!.topicHash
    ) {
      const from = ethers.getAddress('0x' + lg.topics[1].slice(26));
      const to = ethers.getAddress('0x' + lg.topics[2].slice(26));
      const tokenId = BigInt(lg.topics[3]).toString();
      nftEdges.push({
        from,
        to,
        contract: lg.address,
        tokenId,
        amount: BigInt(1)
      });
      continue;
    }

    // ERC1155 TransferSingle
    if (lg.topics[0] === IFACE.getEvent('TransferSingle')!.topicHash) {
      const decoded = IFACE.decodeEventLog(
        'TransferSingle',
        lg.data,
        lg.topics
      );
      const from = decoded.from as string;
      const to = decoded.to as string;
      const id = (decoded.id as bigint).toString();
      const value = decoded.value as bigint;
      nftEdges.push({
        from,
        to,
        contract: lg.address,
        tokenId: id,
        amount: value
      });
      continue;
    }

    // ERC1155 TransferBatch
    if (lg.topics[0] === IFACE.getEvent('TransferBatch')!.topicHash) {
      const decoded = IFACE.decodeEventLog('TransferBatch', lg.data, lg.topics);
      const from = decoded.from as string;
      const to = decoded.to as string;
      const ids = decoded.ids as bigint[];
      const decodedValues = decoded[4] as bigint[]; // values is at index 4 in the result
      ids.forEach((bn, i) => {
        nftEdges.push({
          from,
          to,
          contract: lg.address,
          tokenId: bn.toString(),
          amount: decodedValues?.[i] ?? BigInt(0)
        });
      });
    }
  }

  // 2) Parse Seaport OrderFulfilled events in this tx
  type OrderEvt = {
    orderHash: string;
    offerer: string;
    recipient: string;
    offerNfts: Array<{ contract: string; tokenId: string; amount: bigint }>;
    considerationNfts: Array<{
      contract: string;
      tokenId: string;
      amount: bigint;
      recipient: string;
    }>;
    currencySplits: Array<{
      itemType: number;
      token: string;
      amount: bigint;
      recipient: string;
    }>;
    currency: { itemType: number; token: string } | null;
    valueTotal: bigint; // retained but no longer used for group total
    offerCurrencyTotal: bigint; // NEW: sum of offer-side currency amounts
    considerationCurrencyTotal: bigint; // NEW: sum of consideration-side currency amounts
  };
  const OrderEvts: OrderEvt[] = [];

  for (const lg of receipt.logs) {
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = SEAPORT_IFACE.parseLog(lg);
    } catch {
      // fallback to minimal interface (version-agnostic)
      try {
        parsed = IFACE.parseLog(lg);
      } catch {
        parsed = null;
      }
    }
    if (!parsed || parsed.name !== 'OrderFulfilled') continue;

    const orderHash = parsed.args.orderHash as string;
    const offerer = parsed.args.offerer as string;
    const recipient = parsed.args.recipient as string;

    // Safe access
    let offer: any[] = [];
    let consideration: any[] = [];
    try {
      offer = parsed.args.offer;
      consideration = parsed.args.consideration;
    } catch {
      continue;
    }

    const offerNfts = offer
      .filter((o) => isNftItemType(Number(o.itemType)))
      .map((o) => ({
        contract: o.token as string,
        tokenId: (o.identifier as bigint).toString(),
        amount: o.amount as bigint
      }));

    const considerationNfts = consideration
      .filter((c) => isNftItemType(Number(c.itemType)))
      .map((c) => ({
        contract: c.token as string,
        tokenId: (c.identifier as bigint).toString(),
        amount: c.amount as bigint,
        recipient: c.recipient as string
      }));

    // currency totals on both sides
    let totalOfferCurrency = BigInt(0);
    let currency: { itemType: number; token: string } | null = null;
    for (const o of offer) {
      const it = Number(o.itemType);
      if (isCurrencyItemType(it)) {
        try {
          totalOfferCurrency += o.amount as bigint;
          currency ??= { itemType: it, token: o.token as string };
        } catch (e: any) {
          logger.debug(
            `Error adding currency for transaction ${row.transaction} [ERROR: ${e.message}]`
          );
        }
      }
    }

    const currencySplits: Array<{
      itemType: number;
      token: string;
      amount: bigint;
      recipient: string;
    }> = [];
    // If currency is not set yet, set it in the next loop (consideration)
    for (const c of consideration) {
      const it = Number(c.itemType);
      if (!isCurrencyItemType(it)) continue;
      const amt = valueToWei(c.amount);
      currency ??= { itemType: it, token: c.token };
      currencySplits.push({
        itemType: it,
        token: c.token as string,
        amount: amt,
        recipient: c.recipient as string
      });
    }

    const totalConsiderationCurrency = currencySplits.reduce(
      (acc, s) => acc + s.amount,
      BigInt(0)
    );

    const valueTotal =
      totalOfferCurrency > totalConsiderationCurrency
        ? totalOfferCurrency
        : totalConsiderationCurrency;

    OrderEvts.push({
      orderHash,
      offerer,
      recipient,
      offerNfts,
      considerationNfts,
      currencySplits,
      currency,
      valueTotal,
      offerCurrencyTotal: totalOfferCurrency,
      considerationCurrencyTotal: totalConsiderationCurrency
    });
  }

  if (OrderEvts.length === 0) return null;

  // 3) Find the ONE order event that corresponds to THIS row:
  // Try seller-side (ask/listing) first, then accepted-bid flow (buyer is offerer and NFT is in consideration), then legacy buyer predicates, then fallback.
  const tok = row.contract;
  const idStr = row.token_id.toString();
  const edgeFrom = row.from_address;
  const edgeTo = row.to_address;

  // token matchers
  const tokenMatch = (i: { contract: string; tokenId: string }) =>
    equalIgnoreCase(i.contract, tok) && i.tokenId === idStr;

  const hasOfferToken = (e: OrderEvt) => e.offerNfts.some(tokenMatch);
  const hasConsToken = (e: OrderEvt) => e.considerationNfts.some(tokenMatch);
  const hasConsTokenForTo = (e: OrderEvt) =>
    e.considerationNfts.some(
      (i) => tokenMatch(i) && equalIgnoreCase(i.recipient, edgeTo)
    );

  // predicates in your original priority order
  const strictSeller = (e: OrderEvt) =>
    equalIgnoreCase(e.offerer, edgeFrom) &&
    equalIgnoreCase(e.recipient, edgeTo) &&
    hasOfferToken(e);

  const relaxedSeller = (e: OrderEvt) =>
    equalIgnoreCase(e.offerer, edgeFrom) && hasOfferToken(e);

  // Accepted-bid flow: buyer is offerer, sold NFT appears in consideration.
  const strictBid = (e: OrderEvt) =>
    equalIgnoreCase(e.offerer, edgeTo) &&
    hasConsTokenForTo(e) &&
    equalIgnoreCase(e.recipient, edgeFrom);

  const relaxedBid = (e: OrderEvt) =>
    equalIgnoreCase(e.offerer, edgeTo) && hasConsTokenForTo(e);

  const strictBuyer = (e: OrderEvt) =>
    equalIgnoreCase(e.recipient, edgeTo) && hasConsToken(e);

  const relaxedBuyer = (e: OrderEvt) =>
    hasConsToken(e) &&
    (equalIgnoreCase(e.offerer, edgeFrom) ||
      equalIgnoreCase(e.recipient, edgeTo));

  const lastResort = (): OrderEvt | undefined => {
    const refs = OrderEvts.filter((e) => hasOfferToken(e) || hasConsToken(e));
    return refs.length === 1 ? refs[0] : undefined;
  };

  // find in sequence; `find` returns `undefined` when not found, so `??` is perfect
  const chosen: OrderEvt | undefined =
    OrderEvts.find(strictSeller) ??
    OrderEvts.find(relaxedSeller) ??
    OrderEvts.find(strictBid) ??
    OrderEvts.find(relaxedBid) ??
    OrderEvts.find(strictBuyer) ??
    OrderEvts.find(relaxedBuyer) ??
    lastResort();

  if (!chosen) return null;

  // --- Operator/Conduit guard ---
  // In Seaport fills, NFTs can move seller -> conduit/operator -> buyer.
  // Our DB may have TWO edges for the same token in the same tx:
  //   1) seller -> operator
  //   2) operator -> buyer
  // We must attribute price/royalties ONLY to the public ownership transfer
  // that lands at the actual NFT receiver for the chosen event.
  // If we can see an NFT transfer that ends at that receiver for this token,
  // we require the current row to match that edge; otherwise, we skip attribution
  // for the operator hop to avoid double counting.
  try {
    const tokenEdgesForTx = nftEdges.filter(
      (e) =>
        equalIgnoreCase(e.contract, row.contract) &&
        e.tokenId === row.token_id.toString()
    );
    const tokenOnOfferSide = chosen.offerNfts.some(tokenMatch);
    const tokenConsiderationRecipients = chosen.considerationNfts
      .filter(tokenMatch)
      .map((i) => i.recipient);
    const expectedNftReceiver = tokenOnOfferSide
      ? chosen.recipient
      : (tokenConsiderationRecipients[0] ?? chosen.offerer);
    const ownershipEdge = tokenEdgesForTx.find((e) =>
      equalIgnoreCase(e.to, expectedNftReceiver)
    );
    if (ownershipEdge) {
      // There is an explicit transfer to the buyer in this tx for this token.
      // Only attribute to the row that ends at the buyer; skip seller->operator leg.
      if (!equalIgnoreCase(row.to_address, expectedNftReceiver)) {
        return {
          value: 0,
          royalties: 0,
          currency: chosen.currency ?? null,
          orderHash: chosen.orderHash
        };
      }
    }
  } catch (e: any) {
    logger.debug(
      `Error adding currency for transaction ${row.transaction} [ERROR: ${e.message}]`
    );
  }

  // 4f) If OrdersMatched is present and includes this chosen orderHash, aggregate currency across the matched pair
  let mergedCurrencySplits = chosen.currencySplits.slice();
  let mergedOfferNfts = chosen.offerNfts.slice();
  let mergedConsiderationNfts = chosen.considerationNfts.slice();
  let mergedCurrency: { itemType: number; token: string } | null =
    chosen.currency;
  let mergedOfferCurrencyTotal: bigint = chosen.offerCurrencyTotal;
  let mergedConsiderationCurrencyTotal: bigint =
    chosen.considerationCurrencyTotal;
  let matchedGroupDistinctTokenCount = 0;

  try {
    // find OrdersMatched logs and parse their orderHashes
    const matchLogs = receipt.logs.filter((lg) =>
      equalIgnoreCase(lg.topics?.[0], OPENSEA_MATCH_EVENT)
    );
    for (const ml of matchLogs) {
      let parsedMatch: ethers.LogDescription | null = null;
      try {
        parsedMatch = SEAPORT_IFACE.parseLog(ml);
      } catch {
        try {
          parsedMatch = IFACE.parseLog(ml);
        } catch {
          parsedMatch = null;
        }
      }
      if (!parsedMatch || parsedMatch.name !== 'OrdersMatched') continue;
      const hashes: string[] = (parsedMatch.args.orderHashes as string[]) || [];
      if (!hashes.length) continue;
      if (hashes.some((h) => equalIgnoreCase(h, chosen.orderHash))) {
        // collect sibling orders from this match
        const siblings = OrderEvts.filter((e) =>
          hashes.some((h) => equalIgnoreCase(h, e.orderHash))
        );
        // Collect ALL NFT items across the entire matched group (for fallback/guard logic)
        const siblingsAllNftItems = siblings.flatMap((e) => [
          ...e.offerNfts,
          ...e.considerationNfts
        ]);
        const siblingsAllDistinctTokens = new Set(
          siblingsAllNftItems.map(
            (i) => `${i.contract.toLowerCase()}:${i.tokenId}`
          )
        );
        // Merge ONLY sibling orders that reference THIS token (offer or consideration) to avoid summing unrelated items
        const relevant = siblings.filter(
          (e) =>
            e.offerNfts.some(
              (i) => equalIgnoreCase(i.contract, tok) && i.tokenId === idStr
            ) ||
            e.considerationNfts.some(
              (i) => equalIgnoreCase(i.contract, tok) && i.tokenId === idStr
            )
        );
        if (relevant.length >= 1) {
          // ensure chosen is included
          if (
            !relevant.some((e) =>
              equalIgnoreCase(e.orderHash, chosen.orderHash)
            )
          ) {
            relevant.push(chosen);
          }
          mergedCurrencySplits = [];
          mergedOfferNfts = [];
          mergedConsiderationNfts = [];
          mergedCurrency = chosen.currency; // keep first seen
          mergedOfferCurrencyTotal = BigInt(0);
          mergedConsiderationCurrencyTotal = BigInt(0);
          for (const ev of relevant) {
            mergedOfferNfts.push(...ev.offerNfts);
            mergedConsiderationNfts.push(...ev.considerationNfts);
            if (!mergedCurrency && ev.currency) mergedCurrency = ev.currency;
            mergedCurrencySplits.push(...ev.currencySplits);
            mergedOfferCurrencyTotal += ev.offerCurrencyTotal;
            mergedConsiderationCurrencyTotal += ev.considerationCurrencyTotal;
          }
          // Save group-level counts for fallback decision later
          matchedGroupDistinctTokenCount = siblingsAllDistinctTokens.size;
        }
        break; // only need to process the first match group containing chosen
      }
    }
  } catch (e: any) {
    logger.debug(
      `Error adding currency for transaction ${row.transaction} [ERROR: ${e.message}]`
    );
  }

  // 4) If the chosen/matched group sold multiple NFTs, allocate within THIS GROUP only by executed units.
  const inOffer = mergedOfferNfts.some(
    (i) =>
      equalIgnoreCase(i.contract, row.contract) &&
      i.tokenId === row.token_id.toString()
  );
  const groupNftItems =
    inOffer && mergedOfferNfts.length > 0
      ? mergedOfferNfts
      : mergedConsiderationNfts;

  // Check if the ENTIRE matched group contains only this one token (across all siblings)
  const groupAllNftItems = [...mergedOfferNfts, ...mergedConsiderationNfts];
  const distinctTokens = new Set(
    groupAllNftItems.map((i) => `${i.contract.toLowerCase()}:${i.tokenId}`)
  );
  const onlyThisToken =
    distinctTokens.size === 1 &&
    distinctTokens.has(
      `${row.contract.toLowerCase()}:${row.token_id.toString()}`
    );

  const groupTotalUnits = groupNftItems.reduce(
    (acc, i) => acc + i.amount,
    BigInt(0)
  );
  const groupThisUnits = groupNftItems
    .filter(
      (i) =>
        equalIgnoreCase(i.contract, row.contract) &&
        i.tokenId === row.token_id.toString()
    )
    .reduce((acc, i) => acc + i.amount, BigInt(0));

  if (groupTotalUnits === BigInt(0) || groupThisUnits === BigInt(0))
    return null;

  // Use the larger of offer-side vs consideration-side currency totals across the matched group (prevents double-counting when both sides include full price)
  let groupTotalCurrency =
    mergedOfferCurrencyTotal > mergedConsiderationCurrencyTotal
      ? mergedOfferCurrencyTotal
      : mergedConsiderationCurrencyTotal;
  const groupRoyaltiesToTarget = mergedCurrencySplits
    .filter((s) => equalIgnoreCase(s.recipient, royaltiesAddress))
    .reduce((acc, s) => acc + s.amount, BigInt(0));

  // Fallback: if Seaport consideration splits missed the seller-proceeds (common when split across paired orders),
  // derive total price from ERC20 Transfer logs where buyer (row.to_address) is the sender.
  // This only applies for ERC20 currency (e.g., WETH). ERC20 Transfer has 3 topics: [Transfer, from, to] and amount in data.
  try {
    if (mergedCurrency && mergedCurrency.itemType === ItemType.ERC20) {
      const erc20TransferTopic = IFACE.getEvent('Transfer')!.topicHash; // same signature as ERC721, but ERC20 uses 3 topics
      const splitRecipients = new Set(
        mergedCurrencySplits.map((s) => s.recipient.toLowerCase())
      );
      let buyerOut = BigInt(0);
      for (const lg of receipt.logs) {
        if (
          lg.topics?.length === 3 &&
          lg.topics[0] === erc20TransferTopic &&
          equalIgnoreCase(lg.address, mergedCurrency.token)
        ) {
          const from = ethers.getAddress('0x' + lg.topics[1].slice(26));
          const to = ethers.getAddress('0x' + lg.topics[2].slice(26));
          if (equalIgnoreCase(from, row.to_address)) {
            if (
              splitRecipients.size > 0 &&
              !splitRecipients.has(to.toLowerCase())
            ) {
              continue;
            }
            // amount is in data for ERC20 Transfer
            const amt = BigInt(lg.data);
            buyerOut += amt;
          }
        }
      }
      // Only apply buyer-outflow fallback when the matched group effectively involved ONE token total (no sweep/bundle).
      const safeToOverride =
        matchedGroupDistinctTokenCount === 1 && buyerOut > 0;
      if (safeToOverride && buyerOut > groupTotalCurrency) {
        // override groupTotalCurrency with on-chain ERC20 outflow from the buyer (single-token group only)
        groupTotalCurrency = buyerOut;
      }
    }
  } catch (e: any) {
    logger.debug(
      `Error adding currency for transaction ${row.transaction} [ERROR: ${e.message}]`
    );
  }

  // If the group is only this token, take the full totals (no prorating). Otherwise, prorate by executed units.
  const valueWeiPart = onlyThisToken
    ? groupTotalCurrency
    : (groupTotalCurrency * groupThisUnits) / groupTotalUnits;
  const royaltiesWeiPart = onlyThisToken
    ? groupRoyaltiesToTarget
    : (groupRoyaltiesToTarget * groupThisUnits) / groupTotalUnits;

  if (valueWeiPart === BigInt(0) && royaltiesWeiPart === BigInt(0)) return null;

  return {
    value: Number.parseFloat(ethers.formatEther(valueWeiPart)),
    royalties: Number.parseFloat(ethers.formatEther(royaltiesWeiPart)),
    currency: mergedCurrency,
    orderHash: chosen.orderHash
  };
}
