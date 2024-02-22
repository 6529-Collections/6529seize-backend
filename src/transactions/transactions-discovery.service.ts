import {
  transactionsDb,
  TransactionsDiscoveryDb
} from './transactions.discovery.db';
import {
  Alchemy,
  AssetTransfersCategory,
  AssetTransfersWithMetadataParams,
  AssetTransfersWithMetadataResult,
  fromHex
} from 'alchemy-sdk';
import { getAlchemyInstance } from '../alchemy';
import { Logger } from '../logging';
import { Transaction } from '../entities/ITransaction';
import { findTransactionValues } from '../transaction_values';
import { consolidateTransactions } from '../db';
import { Time } from '../time';
import { discoverEns } from '../ens';

export class TransactionsDiscoveryService {
  private readonly logger = Logger.get(TransactionsDiscoveryService.name);

  constructor(
    private readonly transactionsDb: TransactionsDiscoveryDb,
    private readonly getAlchemyInstance: () => Alchemy,
    private readonly enhanceTransactionValues: (
      transactions: Transaction[]
    ) => Promise<Transaction[]>
  ) {}

  private get alchemy(): Alchemy {
    return this.getAlchemyInstance();
  }

  async getAndSaveTransactionsForContract(
    contract: string,
    startingBlock: number | null
  ): Promise<void> {
    const now = new Date();
    startingBlock =
      startingBlock ?? (await this.getBlockFromWhichToSearchFor(contract));
    this.logger.info(
      `Discovering new transactions for contract ${contract}. Looking from block ${startingBlock}.`
    );
    for await (const transactions of this.getTransactionsFullBlocks(
      contract,
      startingBlock
    )) {
      if (transactions.length) {
        const start = Time.now();
        const minBlock = transactions.at(0)?.block;
        const maxBlock = transactions.at(-1)?.block;
        await this.transactionsDb.batchUpsertTransactions(
          consolidateTransactions(transactions)
        );
        this.logger.info(
          `Saved ${
            transactions.length
          } transactions (blocks ${minBlock}-${maxBlock}) in ${start.diffFromNow()}`
        );
        this.logger.info(`Registering new addresses for ENS`);
        const ensStart = Time.now();
        await discoverEns(now);
        this.logger.info(
          `New addresses registered for ENS in ${ensStart.diffFromNow()}`
        );
      }
    }
    this.logger.info(
      `Transactions discovery complete for contract ${contract}`
    );
  }

  // Gets transactions from alchemy and yields them in batches. It never yields non-complete blocks data.
  // Finishes if it has gotten to current block and there are no more transactions.
  private async *getTransactionsFullBlocks(
    contract: string,
    startingBlock: number
  ): AsyncGenerator<Transaction[], void, void> {
    let pageKey: string | undefined = undefined;
    let transactionsBuffer: Transaction[] = [];
    let fullBlockLastTransactionIndex = -1;
    let timer = Time.now(); // For measuring time between each yield
    do {
      const alchemyParams = this.getAlchemyAssetTransfersParams(
        startingBlock,
        contract,
        pageKey
      );
      const { transfers, pageKey: nextPageKey } =
        await this.alchemy.core.getAssetTransfers(alchemyParams);

      for (const transfer of transfers) {
        const transactions =
          this.mapAlchemyTransferToTransactionEntities(transfer);
        for (const transaction of transactions) {
          if (this.movedToNewBlock(transactionsBuffer, transaction)) {
            fullBlockLastTransactionIndex = transactionsBuffer.length - 1;
          }
          const isReadyForBufferFlush = this.readyToFlushBuffer(
            transactionsBuffer,
            fullBlockLastTransactionIndex
          );
          if (isReadyForBufferFlush) {
            const transactionsReadyForPostprocessing = transactionsBuffer.slice(
              0,
              fullBlockLastTransactionIndex + 1
            );
            const enhancedTransactions =
              await this.enhanceTransactionsWithDetails(
                transactionsReadyForPostprocessing
              );
            transactionsBuffer = transactionsBuffer.slice(
              fullBlockLastTransactionIndex + 1
            );
            this.logger.info(
              `Found and processed ${
                enhancedTransactions.length
              } transactions in ${timer.diffFromNow()}`
            );
            timer = Time.now(); // reset timer
            yield enhancedTransactions;
          }
          transactionsBuffer.push(transaction);
        }
      }
      pageKey = nextPageKey;
    } while (pageKey);

    if (transactionsBuffer.length) {
      const enhancedTransactions = await this.enhanceTransactionsWithDetails(
        transactionsBuffer
      );
      this.logger.info(
        `Found and processed ${
          enhancedTransactions.length
        } transactions in ${timer.diffFromNow()}`
      );
      yield enhancedTransactions;
    }
  }

  private readyToFlushBuffer(
    transactionsBuffer: Transaction[],
    fullBlockLastTransactionIndex: number
  ) {
    return (
      transactionsBuffer.length > 150 && fullBlockLastTransactionIndex >= 0
    );
  }

  private movedToNewBlock(
    transactionsBuffer: Transaction[],
    transaction: Transaction
  ) {
    return (
      transactionsBuffer.length &&
      transactionsBuffer.at(-1)!.block !== transaction.block
    );
  }

  private getAlchemyAssetTransfersParams(
    startingBlock: number,
    contract: string,
    pageKey?: string
  ): AssetTransfersWithMetadataParams {
    const startingBlockHex = `0x${startingBlock.toString(16)}`;
    return {
      category: [AssetTransfersCategory.ERC1155, AssetTransfersCategory.ERC721],
      contractAddresses: [contract],
      withMetadata: true,
      maxCount: 150,
      fromBlock: startingBlockHex,
      pageKey: pageKey
    };
  }

  private async getBlockFromWhichToSearchFor(
    contract: string
  ): Promise<number> {
    const latestBlock =
      await this.transactionsDb.getLatestTransactionsBlockForContract(contract);
    return latestBlock + 1;
  }

  private mapAlchemyTransferToTransactionEntities(
    t: AssetTransfersWithMetadataResult
  ): Transaction[] {
    if (t.erc721TokenId) {
      const tokenId = parseInt(t.erc721TokenId, 16);
      const tokenCount = 1;
      if (t.to && t.rawContract.address) {
        return [
          {
            created_at: new Date(),
            transaction: t.hash,
            block: fromHex(t.blockNum),
            transaction_date: new Date(t.metadata.blockTimestamp),
            from_address: t.from,
            to_address: t.to,
            contract: t.rawContract.address,
            token_id: tokenId,
            token_count: tokenCount,
            value: 0,
            primary_proceeds: 0,
            royalties: 0,
            gas_gwei: 0,
            gas_price: 0,
            gas_price_gwei: 0,
            gas: 0
          }
        ];
      }
    } else if (t.erc1155Metadata) {
      return t.erc1155Metadata
        .map((md) => {
          const tokenId = parseInt(md.tokenId, 16);
          const tokenCount = parseInt(md.value, 16);
          if (t.to && t.rawContract.address) {
            return {
              created_at: new Date(),
              transaction: t.hash,
              block: fromHex(t.blockNum),
              transaction_date: new Date(t.metadata.blockTimestamp),
              from_address: t.from,
              to_address: t.to,
              contract: t.rawContract.address,
              token_id: tokenId,
              token_count: tokenCount,
              value: 0,
              royalties: 0,
              primary_proceeds: 0,
              gas_gwei: 0,
              gas_price: 0,
              gas_price_gwei: 0,
              gas: 0
            };
          }
          return null;
        })
        .filter((t: Transaction | null) => t !== null) as Transaction[];
    }
    this.logger.warn(
      `Could not map transaction ${t.hash}. It was for neither ERC721 nor ERC1155.`
    );
    return [];
  }

  private async enhanceTransactionsWithDetails(
    transactions: Transaction[]
  ): Promise<Transaction[]> {
    if (!transactions.length) {
      return transactions;
    }
    return this.enhanceTransactionValues(transactions);
  }
}

export const transactionsDiscoveryService = new TransactionsDiscoveryService(
  transactionsDb,
  getAlchemyInstance,
  findTransactionValues
);
