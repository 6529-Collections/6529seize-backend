import {
  Alchemy,
  AssetTransfersCategory,
  AssetTransfersWithMetadataParams,
  TransactionResponse
} from 'alchemy-sdk';
import {
  ALCHEMY_SETTINGS,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  MEMES_DEPLOYER
} from './constants';
import {
  fetchLatestNftHistoryBlockNumber,
  fetchLatestNftUri,
  persistNftHistory,
  persistNftHistoryBlock
} from './db';
import { NFTHistory } from './entities/INFTHistory';
import { NFT_HISTORY_IFACE } from './abis/nft_history';
import { RequestInfo, RequestInit } from 'node-fetch';
import { areEqualAddresses } from './helpers';
import { get } from 'http';

const fetch = (url: RequestInfo, init?: RequestInit) =>
  import('node-fetch').then(({ default: fetch }) => fetch(url, init));

let alchemy: Alchemy;

const MINT_BASE_NEW_METHOD = '0xfeeb5a9a';
const SET_TOKEN_URI_METHOD = '0x162094c4';

async function getAllTransactions(
  startingBlock: number,
  latestBlock: number,
  key: any
) {
  const startingBlockHex = `0x${startingBlock.toString(16)}`;
  const latestBlockHex = `0x${latestBlock.toString(16)}`;

  console.log(
    new Date(),
    '[NFT HISTORY]',
    `[FROM BLOCK ${startingBlockHex}]`,
    `[TO BLOCK ${latestBlockHex}]`,
    `[PAGE KEY ${key}]`
  );

  const settings: AssetTransfersWithMetadataParams = {
    category: [AssetTransfersCategory.EXTERNAL, AssetTransfersCategory.ERC20],
    excludeZeroValue: false,
    maxCount: 150,
    fromBlock: startingBlockHex,
    toBlock: latestBlockHex,
    pageKey: key ? key : undefined,
    fromAddress: MEMES_DEPLOYER,
    withMetadata: true
  };

  const response = await alchemy.core.getAssetTransfers(settings);
  return response;
}

const findDetailsFromTransaction = async (tx: TransactionResponse) => {
  if (tx.data) {
    const data = tx.data;
    try {
      const parsed = NFT_HISTORY_IFACE.parseTransaction({
        data,
        value: 0
      });
      if (parsed.args.uris) {
        const tokenUri = parsed.args.uris[0];
        const receipt = await alchemy.core.getTransactionReceipt(tx.hash);
        const logData = receipt?.logs[0].data;
        if (logData && tx.to) {
          const parsedReceipt = NFT_HISTORY_IFACE.parseLog({
            topics: receipt?.logs[0].topics,
            data: logData
          });
          const tokenId = parsedReceipt.args.id.toNumber();
          if (areEqualAddresses(MEMES_CONTRACT, tx.to)) {
            return {
              contract: MEMES_CONTRACT,
              tokenId,
              tokenUri
            };
          }
          if (areEqualAddresses(MEMELAB_CONTRACT, tx.to)) {
            return {
              contract: MEMELAB_CONTRACT,
              tokenId,
              tokenUri
            };
          }
        }
      }
      if (parsed.args.uri_ && parsed.args.tokenId && tx.to) {
        if (areEqualAddresses(MEMES_CONTRACT, tx.to)) {
          return {
            contract: MEMES_CONTRACT,
            tokenId: parsed.args.tokenId.toNumber(),
            tokenUri: parsed.args.uri_
          };
        }
        if (areEqualAddresses(MEMELAB_CONTRACT, tx.to)) {
          return {
            contract: MEMELAB_CONTRACT,
            tokenId: parsed.args.tokenId.toNumber(),
            tokenUri: parsed.args.uri_
          };
        }
      }
    } catch (e: any) {
      console.log('[NFT HISTORY]', `[ERROR PARSING TX ${tx.hash}]`, e.message);
    }
  }
  return null;
};

const compareProperties = (a: any, b: any, key: string) => {
  const aVal = JSON.stringify(a[key]);
  const bVal = JSON.stringify(b[key]);
  return aVal !== bVal;
};

const getEditDescription = async (
  tokenId: number,
  contract: string,
  newUri: string
) => {
  let editDescription = '';
  const previousUri = await fetchLatestNftUri(tokenId, contract);
  if (previousUri) {
    const previousMeta = await (await fetch(previousUri)).json();
    const newMeta = await (await fetch(newUri)).json();
    const changes: string[] = [];
    // for (const key in previousMeta) {
    //   if (
    //     previousMeta.hasOwnProperty(key) &&
    //     previousMeta[key] !== newMeta[key]
    //   ) {
    //     changes.push(
    //       `Property '${key}' changed\n'${previousMeta[key]}' -> '${newMeta[key]}'`
    //     );
    //   }
    // }
    if (compareProperties(previousMeta, newMeta, 'name')) {
      changes.push(
        `- Name changed\n\n${previousMeta.name} -> ${newMeta.name}\n`
      );
    }
    if (compareProperties(previousMeta, newMeta, 'created_by')) {
      changes.push(
        `- Created By changed\n\n${previousMeta.created_by} -> ${newMeta.created_by}\n`
      );
    }
    if (compareProperties(previousMeta, newMeta, 'external_url')) {
      changes.push(
        `- External URL changed\n\n${previousMeta.external_url} -> ${newMeta.external_url}\n`
      );
    }
    if (compareProperties(previousMeta, newMeta, 'description')) {
      changes.push(
        `- Description changed\n\n${previousMeta.description} -> ${newMeta.description}\n`
      );
    }
    if (compareProperties(previousMeta, newMeta, 'attributes')) {
      changes.push(`- Attributes changed\n`);
    }
    if (compareProperties(previousMeta, newMeta, 'animation')) {
      changes.push(
        `- Animation changed\n\n${previousMeta.animation} -> ${newMeta.animation}\n`
      );
    }
    if (
      compareProperties(previousMeta, newMeta, 'animation_url') &&
      !compareProperties(previousMeta, newMeta, 'animation')
    ) {
      changes.push(
        `- Animation URL changed\n\n${previousMeta.animation_url} -> ${newMeta.animation_url}\n`
      );
    }
    if (compareProperties(previousMeta, newMeta, 'animation_details')) {
      changes.push(`- Animation Details changed\n`);
    }
    if (compareProperties(previousMeta, newMeta, 'image')) {
      changes.push(
        `- Image changed\n\n${previousMeta.image} -> ${newMeta.image}\n`
      );
    }
    if (
      compareProperties(previousMeta, newMeta, 'image_url') &&
      !compareProperties(previousMeta, newMeta, 'image')
    ) {
      changes.push(
        `- Image URL changed\n\n${previousMeta.image_url} -> ${newMeta.image_url}\n`
      );
    }
    if (compareProperties(previousMeta, newMeta, 'image_details')) {
      changes.push(`- Image Details changed\n`);
    }
    if (changes.length > 0) {
      editDescription += changes.join('\n');
    }
  } else {
    editDescription = 'Edited';
  }
  return editDescription;
};

export const findTransactions = async (
  startingBlock: number,
  latestBlock?: number,
  pageKey?: string
) => {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  if (!latestBlock) {
    latestBlock = await alchemy.core.getBlockNumber();
    console.log(
      new Date(),
      '[NFT HISTORY]',
      `[STARTING BLOCK ${startingBlock}]`,
      `[LATEST BLOCK ON CHAIN ${latestBlock}]`
    );
  }

  const transactionsResponse = await getAllTransactions(
    startingBlock,
    latestBlock,
    pageKey
  );

  console.log(
    new Date(),
    '[NFT HISTORY]',
    `[FOUND ${transactionsResponse.transfers.length} NEW TRANSACTIONS]`
  );

  const nftMintHistory: NFTHistory[] = [];
  await Promise.all(
    transactionsResponse.transfers.map(async (t) => {
      const tx = await alchemy.core.getTransaction(t.hash);
      if (tx?.data.startsWith(MINT_BASE_NEW_METHOD)) {
        const details = await findDetailsFromTransaction(tx);
        if (details) {
          const nftMint: NFTHistory = {
            created_at: new Date(),
            nft_id: details.tokenId,
            contract: details.contract,
            uri: details.tokenUri,
            transaction_date: new Date(t.metadata.blockTimestamp),
            transaction_hash: t.hash,
            block: parseInt(t.blockNum, 16),
            description: 'Minted'
          };
          nftMintHistory.push(nftMint);
        }
      }
    })
  );

  await persistNftHistory(nftMintHistory);

  const nftEditHistory: NFTHistory[] = [];
  await Promise.all(
    transactionsResponse.transfers.map(async (t) => {
      const tx = await alchemy.core.getTransaction(t.hash);
      if (tx?.data.startsWith(SET_TOKEN_URI_METHOD)) {
        const details = await findDetailsFromTransaction(tx);
        if (details) {
          const editDescription = await getEditDescription(
            details.tokenId,
            details.contract,
            details.tokenUri
          );
          const nftEdit: NFTHistory = {
            created_at: new Date(),
            nft_id: details.tokenId,
            contract: details.contract,
            uri: details.tokenUri,
            transaction_date: new Date(t.metadata.blockTimestamp),
            transaction_hash: t.hash,
            block: parseInt(t.blockNum, 16),
            description: editDescription
          };
          nftEditHistory.push(nftEdit);
        }
      }
    })
  );

  await persistNftHistory(nftEditHistory);

  return {
    latestBlock: latestBlock,
    pageKey: transactionsResponse.pageKey
  };
};

export const findNFTHistory = async (
  startingBlock?: number,
  latestBlock?: number,
  pagKey?: string
) => {
  try {
    let startingBlockResolved: number;
    if (startingBlock == undefined) {
      startingBlockResolved = await fetchLatestNftHistoryBlockNumber();
      if (!startingBlockResolved) {
        startingBlockResolved = 0;
      }
    } else {
      startingBlockResolved = startingBlock;
    }

    const response = await findTransactions(
      startingBlockResolved,
      latestBlock,
      pagKey
    );

    if (response.pageKey) {
      await findNFTHistory(
        startingBlockResolved,
        response.latestBlock,
        response.pageKey
      );
    } else {
      await persistNftHistoryBlock(response.latestBlock);
    }
  } catch (e: any) {
    console.log('[NFT HISTORY]', '[ETIMEDOUT!]', e, '[RETRYING PROCESS]');
    await findNFTHistory(startingBlock, latestBlock, pagKey);
  }
};
