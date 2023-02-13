import {
  Alchemy,
  AssetTransfersCategory,
  AssetTransfersWithMetadataParams,
  fromHex,
  toHex
} from 'alchemy-sdk';
import {
  ALCHEMY_SETTINGS,
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from './constants';
import { Transaction } from './entities/ITransaction';

let alchemy: Alchemy;

async function getAllTransactions(
  startingBlock: number,
  latestBlock: number,
  key: any,
  contracts?: string[]
) {
  console.log(
    new Date(),
    '[TRANSACTIONS]',
    `[FROM BLOCK ${toHex(startingBlock)}]`,
    `[TO BLOCK ${toHex(latestBlock)}]`,
    `[PAGE KEY ${key}]`
  );

  const settings: AssetTransfersWithMetadataParams = {
    category: [AssetTransfersCategory.ERC1155, AssetTransfersCategory.ERC721],
    contractAddresses: contracts
      ? contracts
      : [MEMES_CONTRACT, GRADIENT_CONTRACT],
    withMetadata: true,
    maxCount: 250,
    fromBlock: toHex(startingBlock),
    toBlock: toHex(latestBlock),
    pageKey: key ? key : undefined
  };

  const response = await alchemy.core.getAssetTransfers(settings);
  return response;
}

export const findTransactions = async (
  startingBlock: number,
  latestBlock?: number,
  pageKey?: string,
  contracts?: string[]
) => {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  if (!latestBlock) {
    latestBlock = await alchemy.core.getBlockNumber();
    console.log(
      new Date(),
      '[TRANSACTIONS]',
      `[STARTING BLOCK ${startingBlock}]`,
      `[LATEST BLOCK ON CHAIN ${latestBlock}]`
    );
  }

  const timestamp = (await alchemy.core.getBlock(latestBlock)).timestamp;

  const transactions = await getAllTransactions(
    startingBlock,
    latestBlock,
    pageKey,
    contracts
  );

  console.log(
    new Date(),
    '[TRANSACTIONS]',
    `[FOUND ${transactions.transfers.length} NEW TRANSACTIONS]`
  );

  if (transactions.transfers.length == 0) {
    return {
      latestBlock: latestBlock,
      latestBlockTimestamp: new Date(timestamp * 1000),
      transactions: []
    };
  }

  const finalTransactions: Transaction[] = [];

  await Promise.all(
    transactions.transfers.map(async (t) => {
      if (t.erc721TokenId) {
        const tokenId = parseInt(t.erc721TokenId, 16);
        const tokenCount = 1;
        if (t.to && t.rawContract.address) {
          const finalTransaction: Transaction = {
            created_at: new Date(),
            transaction: t.hash,
            block: fromHex(t.blockNum),
            transaction_date: new Date(t.metadata.blockTimestamp),
            from_address: t.from,
            to_address: t.to,
            contract: t.rawContract.address,
            token_id: tokenId,
            token_count: tokenCount,
            value: 0
          };
          finalTransactions.push(finalTransaction);
        }
      } else if (t.erc1155Metadata) {
        t.erc1155Metadata.map((md) => {
          const tokenId = parseInt(md.tokenId, 16);
          const tokenCount = parseInt(md.value, 16);
          if (t.to && t.rawContract.address) {
            const finalTransaction: Transaction = {
              created_at: new Date(),
              transaction: t.hash,
              block: fromHex(t.blockNum),
              transaction_date: new Date(t.metadata.blockTimestamp),
              from_address: t.from,
              to_address: t.to,
              contract: t.rawContract.address,
              token_id: tokenId,
              token_count: tokenCount,
              value: 0
            };
            finalTransactions.push(finalTransaction);
          }
        });
      }
    })
  );

  console.log(
    new Date(),
    '[TRANSACTIONS]',
    `[PROCESSED ${finalTransactions.length} TRANSACTIONS]`
  );

  return {
    latestBlock: latestBlock,
    latestBlockTimestamp: new Date(timestamp * 1000),
    transactions: finalTransactions,
    pageKey: transactions.pageKey
  };
};
