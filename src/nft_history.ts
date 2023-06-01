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

function getAttributeChanges(oldAttributes: any[], newAttributes: any[]) {
  const changes: any[] = [];

  const oldAttributesMap = new Map();
  oldAttributes.forEach((attribute: any) => {
    oldAttributesMap.set(attribute.trait_type, attribute.value);
  });

  newAttributes.forEach((attribute: any) => {
    const traitType = attribute.trait_type;
    const value = attribute.value;

    if (oldAttributesMap.has(traitType)) {
      const oldValue = oldAttributesMap.get(traitType);
      if (oldValue !== value) {
        changes.push({
          trait_type: traitType,
          old_value: oldValue,
          new_value: value
        });
      }
    }
  });

  return changes;
}

const getEditDescription = async (
  tokenId: number,
  contract: string,
  newUri: string
) => {
  const previousUri = await fetchLatestNftUri(tokenId, contract);
  if (previousUri) {
    const previousMeta = await (await fetch(previousUri)).json();
    const newMeta = await (await fetch(newUri)).json();
    const changes: any[] = [];
    for (const key in previousMeta) {
      if (typeof previousMeta[key] != 'object') {
        if (previousMeta[key] !== newMeta[key]) {
          changes.push({ key: key, from: previousMeta[key], to: newMeta[key] });
        }
      } else {
        if (key == 'attributes') {
          const attributeChanges = getAttributeChanges(
            previousMeta[key],
            newMeta[key]
          );
          attributeChanges.map((change) => {
            changes.push({
              key: `${key}::${change.trait_type}`,
              from: change.old_value,
              to: change.new_value
            });
          });
        } else {
          for (const key2 in previousMeta[key]) {
            if (
              typeof previousMeta[key][key2] != 'object' &&
              previousMeta[key][key2] !== newMeta[key][key2]
            ) {
              changes.push({
                key: `${key}::${key2}`,
                from: previousMeta[key][key2],
                to: newMeta[key][key2]
              });
            }
          }
        }
      }
    }

    // if (compareProperties(previousMeta, newMeta, 'name')) {
    //   changes.name = {
    //     from: previousMeta.name,
    //     to: newMeta.name
    //   };
    // }
    // if (compareProperties(previousMeta, newMeta, 'created_by')) {
    //   changes.created_by = {
    //     from: previousMeta.created_by,
    //     to: newMeta.created_by
    //   };
    // }
    // if (compareProperties(previousMeta, newMeta, 'external_url')) {
    //   changes.external_url = {
    //     from: previousMeta.external_url,
    //     to: newMeta.external_url
    //   };
    // }
    // if (compareProperties(previousMeta, newMeta, 'description')) {
    //   changes.description = {
    //     from: previousMeta.description,
    //     to: newMeta.description
    //   };
    // }
    // if (compareProperties(previousMeta, newMeta, 'attributes')) {
    //   changes.attributes = {
    //     from: previousMeta.attributes,
    //     to: newMeta.attributes
    //   };
    // }
    // if (compareProperties(previousMeta, newMeta, 'animation')) {
    //   changes.animation = {
    //     from: previousMeta.animation,
    //     to: newMeta.animation
    //   };
    // }
    // if (
    //   compareProperties(previousMeta, newMeta, 'animation_url') &&
    //   !compareProperties(previousMeta, newMeta, 'animation')
    // ) {
    //   changes.animation_url = {
    //     from: previousMeta.animation_url,
    //     to: newMeta.animation_url
    //   };
    // }
    // if (compareProperties(previousMeta, newMeta, 'animation_details')) {
    //   changes.animation_details = {
    //     from: previousMeta.animation_details,
    //     to: newMeta.animation_details
    //   };
    // }
    // if (compareProperties(previousMeta, newMeta, 'image')) {
    //   changes.image = {
    //     from: previousMeta.image,
    //     to: newMeta.image
    //   };
    // }
    // if (
    //   compareProperties(previousMeta, newMeta, 'image_url') &&
    //   !compareProperties(previousMeta, newMeta, 'image')
    // ) {
    //   changes.image_url = {
    //     from: previousMeta.image_url,
    //     to: newMeta.image_url
    //   };
    // }
    // if (compareProperties(previousMeta, newMeta, 'image_details')) {
    //   changes.image_details = {
    //     from: previousMeta.image_details,
    //     to: newMeta.image_details
    //   };
    // }
    return {
      event: 'Edit',
      changes: changes
    };
  }
  return {
    event: 'Edit'
  };
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
            description: {
              event: 'Mint',
              changes: []
            }
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
