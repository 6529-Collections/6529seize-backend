import {
  Alchemy,
  AssetTransfersCategory,
  AssetTransfersWithMetadataParams,
  AssetTransfersWithMetadataResult,
  SortingOrder,
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
  findClaim,
  persistNftClaims,
  persistNftHistory,
  persistNftHistoryBlock
} from './db';
import { NFTHistory, NFTHistoryClaim } from './entities/INFTHistory';
import { NFT_HISTORY_IFACE } from './abis/nft_history';
import { Logger } from './logging';
import { equalIgnoreCase } from './strings';

const logger = Logger.get('NFT_HISTORY');

let alchemy: Alchemy;

const MINT_BASE_NEW_METHOD = '0xfeeb5a9a';
const SET_TOKEN_URI_METHOD = '0x162094c4';
const INITIALIZE_CLAIM_METHOD_1 = '0xcc3d8ab3';
const INITIALIZE_CLAIM_METHOD_2 = '0xd670c080';
const INITIALIZE_CLAIM_METHOD_3 = '0x809e7c37';
const AIRDROP_METHOD = '0xbd04e411';
const INITIALIZE_BURN_METHOD = '0x38ec8995';
const UPDATE_CLAIM_METHOD_1 = '0xa310099c';
const UPDATE_CLAIM_METHOD_2 = '0x0a6330b8';
const UPDATE_CLAIM_METHOD_3 = '0xe505bb01';

/* istanbul ignore next */
async function getAllDeployerTransactions(
  startingBlock: number,
  latestBlock: number,
  key: any
) {
  const startingBlockHex = `0x${startingBlock.toString(16)}`;
  const latestBlockHex = `0x${latestBlock.toString(16)}`;

  logger.info(
    `[DEPLOYER] [FROM BLOCK ${startingBlockHex}] [TO BLOCK ${latestBlockHex}] [PAGE KEY ${key}]`
  );

  const settings: AssetTransfersWithMetadataParams = {
    category: [AssetTransfersCategory.EXTERNAL, AssetTransfersCategory.ERC20],
    excludeZeroValue: false,
    maxCount: 150,
    fromBlock: startingBlockHex,
    toBlock: latestBlockHex,
    pageKey: key ?? undefined,
    fromAddress: MEMES_DEPLOYER,
    withMetadata: true,
    order: SortingOrder.ASCENDING
  };

  const response = await alchemy.core.getAssetTransfers(settings);
  return response;
}

/* istanbul ignore next */
const findDetailsFromTransaction = async (tx: TransactionResponse) => {
  if (tx.data) {
    const data = tx.data;
    try {
      const parsed = NFT_HISTORY_IFACE.parseTransaction({
        data,
        value: 0
      });
      if (parsed && parsed.args.uris) {
        const tokenUri = parsed.args.uris[0];
        const receipt = await alchemy.core.getTransactionReceipt(tx.hash);
        const logData = receipt?.logs[0].data;
        if (logData && tx.to) {
          const parsedReceipt = NFT_HISTORY_IFACE.parseLog({
            topics: receipt?.logs[0].topics,
            data: logData
          });
          if (!parsedReceipt) {
            return null;
          }
          const tokenId = Number(parsedReceipt.args.id);
          if (equalIgnoreCase(MEMES_CONTRACT, tx.to)) {
            return {
              contract: MEMES_CONTRACT,
              tokenId,
              tokenUri
            };
          }
          if (equalIgnoreCase(MEMELAB_CONTRACT, tx.to)) {
            return {
              contract: MEMELAB_CONTRACT,
              tokenId,
              tokenUri
            };
          }
        }
      }
      if (parsed && parsed.args.uri_ && parsed.args.tokenId && tx.to) {
        if (equalIgnoreCase(MEMES_CONTRACT, tx.to)) {
          return {
            contract: MEMES_CONTRACT,
            tokenId: Number(parsed.args.tokenId),
            tokenUri: parsed.args.uri_
          };
        }
        if (equalIgnoreCase(MEMELAB_CONTRACT, tx.to)) {
          return {
            contract: MEMELAB_CONTRACT,
            tokenId: Number(parsed.args.tokenId),
            tokenUri: parsed.args.uri_
          };
        }
      }
    } catch (e: any) {
      logger.error(`[ERROR PARSING TX ${tx.hash}] [${e}]`);
    }
  }
  return null;
};

export function getAttributeChanges(
  oldAttributes: any[],
  newAttributes: any[]
) {
  const changes: any[] = [];

  const oldAttributesMap = new Map();
  oldAttributes.forEach((attribute: any) => {
    oldAttributesMap.set(attribute.trait_type, attribute.value);
  });

  const newAttributesMap = new Map();
  newAttributes.forEach((attribute: any) => {
    newAttributesMap.set(attribute.trait_type, attribute.value);
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
    } else {
      changes.push({
        trait_type: `${traitType} (Added)`,
        old_value: '',
        new_value: value
      });
    }
  });

  oldAttributes.forEach((attribute: any) => {
    const traitType = attribute.trait_type;
    const value = attribute.value;

    if (!newAttributesMap.has(traitType)) {
      changes.push({
        trait_type: `${traitType} (Removed)`,
        old_value: value,
        new_value: ''
      });
    }
  });

  return changes;
}

export const getEditDescription = async (
  tokenId: number,
  contract: string,
  newUri: string,
  blockNumber: number
) => {
  const previousUri = await fetchLatestNftUri(tokenId, contract, blockNumber);
  if (previousUri && !equalIgnoreCase(previousUri, newUri)) {
    const previousMeta: any = await (await fetch(previousUri)).json();
    const newMeta: any = await (await fetch(newUri)).json();

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
          attributeChanges.forEach((change) => {
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
    for (const key in newMeta) {
      if (!previousMeta[key]) {
        if (typeof newMeta[key] != 'object') {
          changes.push({ key: key, from: '', to: newMeta[key] });
        } else {
          if (key == 'attributes') {
            const attributeChanges = getAttributeChanges(
              previousMeta[key],
              newMeta[key]
            );
            attributeChanges.forEach((change) => {
              changes.push({
                key: `${key}::${change.trait_type}`,
                from: change.old_value,
                to: change.new_value
              });
            });
          } else {
            for (const key2 in newMeta[key]) {
              if (typeof newMeta[key][key2] != 'object') {
                changes.push({
                  key: `${key}::${key2}`,
                  from: '',
                  to: newMeta[key][key2]
                });
              }
            }
          }
        }
      }
    }
    return {
      event: 'Edit',
      changes: changes
    };
  }
  return null;
};

/* istanbul ignore next */
export const getDeployerTransactions = async (
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
    logger.info(
      `[STARTING BLOCK ${startingBlock}] [LATEST BLOCK ON CHAIN ${latestBlock}]`
    );
  }

  const assetResponse = await getAllDeployerTransactions(
    startingBlock,
    latestBlock,
    pageKey
  );

  logger.info(
    `[DEPLOYER] [FOUND ${assetResponse.transfers.length} NEW TRANSACTIONS] [PARSING...]`
  );

  const transactionsResponse: {
    t: AssetTransfersWithMetadataResult;
    tx: TransactionResponse;
  }[] = [];
  await Promise.all(
    assetResponse.transfers.map(async (t) => {
      const tx = await alchemy.core.getTransaction(t.hash);
      if (tx) transactionsResponse.push({ t, tx });
    })
  );

  const sortedTransactionsResponse = transactionsResponse.sort((a, b) => {
    const timestampA = new Date(a.t.metadata.blockTimestamp).getTime();
    const timestampB = new Date(b.t.metadata.blockTimestamp).getTime();
    return timestampA - timestampB;
  });

  for (const tr of sortedTransactionsResponse) {
    const t = tr.t;
    const tx = tr.tx;
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
        await persistNftHistory([nftMint]);
      }
    } else if (tx?.data.startsWith(INITIALIZE_CLAIM_METHOD_1)) {
      const data = tx.data;
      try {
        const parsed = NFT_HISTORY_IFACE.parseTransaction({
          data,
          value: 0
        });
        if (!parsed) {
          throw new Error('Failed to parse transaction');
        }
        const claimIndex = Number(parsed.args.claimIndex);
        const location = parsed.args.claimParameters.location;
        const contract = parsed.args.creatorContractAddress;
        const claim: NFTHistoryClaim = {
          claimIndex,
          location,
          contract
        };
        await persistNftClaims([claim]);
      } catch (e: any) {
        logger.info(`[ERROR PARSING TX ${tx.hash}] [${e.message}]`);
      }
    } else if (tx?.data.startsWith(INITIALIZE_CLAIM_METHOD_2)) {
      const data = tx.data;
      try {
        const parsed = NFT_HISTORY_IFACE.parseTransaction({
          data,
          value: 0
        });
        if (!parsed) {
          throw new Error('Failed to parse transaction');
        }
        const claimIndex = Number(parsed.args.claimIndex);
        const location = parsed.args.claimParameters.location;
        const contract = parsed.args.creatorContractAddress;
        const receipt = await alchemy.core.getTransactionReceipt(tx.hash);
        const logData = receipt?.logs[0].data;
        if (logData && tx.to) {
          const parsedReceipt = NFT_HISTORY_IFACE.parseLog({
            topics: receipt?.logs[0].topics,
            data: logData
          });
          if (!parsedReceipt) {
            throw new Error('Failed to parse receipt');
          }
          const tokenId = Number(parsedReceipt.args.id);
          const nftMint: NFTHistory = {
            created_at: new Date(),
            nft_id: tokenId,
            contract: contract,
            uri: `https://arweave.net/${location}`,
            transaction_date: new Date(t.metadata.blockTimestamp),
            transaction_hash: t.hash,
            block: parseInt(t.blockNum, 16),
            description: {
              event: 'Mint',
              changes: []
            }
          };
          await persistNftHistory([nftMint]);
          const claim: NFTHistoryClaim = {
            claimIndex,
            location,
            contract,
            nft_id: tokenId
          };
          await persistNftClaims([claim]);
        }
      } catch (e: any) {
        logger.error(`[ERROR PARSING TX ${tx.hash}] [${e}]`);
      }
    } else if (tx?.data.startsWith(INITIALIZE_CLAIM_METHOD_3)) {
      const data = tx.data;
      try {
        const parsed = NFT_HISTORY_IFACE.parseTransaction({
          data,
          value: 0
        });
        if (!parsed) {
          throw new Error('Failed to parse transaction');
        }
        const instanceId = Number(parsed.args.instanceId);
        const location = parsed.args.claimParameters.location;
        const contract = parsed.args.creatorContractAddress;
        const claim: NFTHistoryClaim = {
          claimIndex: instanceId,
          location,
          contract
        };
        await persistNftClaims([claim]);
      } catch (e: any) {
        logger.info(`[ERROR PARSING TX ${tx.hash}] [${e.message}]`);
      }
    } else if (tx?.data.startsWith(INITIALIZE_BURN_METHOD)) {
      const data = tx.data;
      try {
        const parsed = NFT_HISTORY_IFACE.parseTransaction({
          data,
          value: 0
        });
        if (!parsed) {
          throw new Error('Failed to parse transaction');
        }
        const location = parsed.args.burnRedeemParameters.location;
        const contract = parsed.args.creatorContractAddress;
        const receipt = await alchemy.core.getTransactionReceipt(tx.hash);
        const logData = receipt?.logs[1].data;
        if (logData && tx.to) {
          const parsedReceipt = NFT_HISTORY_IFACE.parseLog({
            topics: receipt?.logs[1].topics,
            data: logData
          });
          if (!parsedReceipt) {
            throw new Error('Failed to parse receipt');
          }
          const tokenId = Number(parsedReceipt.args.id);
          const nftMint: NFTHistory = {
            created_at: new Date(),
            nft_id: tokenId,
            contract: contract,
            uri: `https://arweave.net/${location}`,
            transaction_date: new Date(t.metadata.blockTimestamp),
            transaction_hash: t.hash,
            block: parseInt(t.blockNum, 16),
            description: {
              event: 'Mint',
              changes: []
            }
          };
          await persistNftHistory([nftMint]);
        }
      } catch (e: any) {
        logger.error(`[ERROR PARSING TX ${tx.hash}] [${e}]`);
      }
    } else if (tx?.data.startsWith(SET_TOKEN_URI_METHOD)) {
      const details = await findDetailsFromTransaction(tx);
      if (details) {
        const editDescription = await getEditDescription(
          details.tokenId,
          details.contract,
          details.tokenUri,
          tx.blockNumber!
        );
        if (editDescription) {
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
          await persistNftHistory([nftEdit]);
        }
      }
    } else if (tx?.data.startsWith(AIRDROP_METHOD)) {
      const data = tx.data;
      try {
        const parsed = NFT_HISTORY_IFACE.parseTransaction({
          data,
          value: 0
        });
        if (!parsed) {
          throw new Error('Failed to parse transaction');
        }
        const claimIndex = Number(parsed.args.claimIndex);
        const receipt = await alchemy.core.getTransactionReceipt(tx.hash);
        const logData = receipt?.logs[0].data;
        if (logData && tx.to) {
          const parsedReceipt = NFT_HISTORY_IFACE.parseLog({
            topics: receipt?.logs[0].topics,
            data: logData
          });
          if (!parsedReceipt) {
            throw new Error('Failed to parse receipt');
          }
          const claims = await findClaim(claimIndex, -1);
          for (const claim of claims) {
            const tokenId = Number(parsedReceipt.args.id);
            claim.nft_id = tokenId;
            const nftMint: NFTHistory = {
              created_at: new Date(),
              nft_id: tokenId,
              contract: claim.contract,
              uri: `https://arweave.net/${claim.location}`,
              transaction_date: new Date(t.metadata.blockTimestamp),
              transaction_hash: t.hash,
              block: parseInt(t.blockNum, 16),
              description: {
                event: 'Mint',
                changes: []
              }
            };
            await persistNftClaims([claim]);
            await persistNftHistory([nftMint]);
          }
        }
      } catch (e: any) {
        logger.error(`[ERROR PARSING TX ${tx.hash}] [${e}]`);
      }
    } else if (
      tx?.data.startsWith(UPDATE_CLAIM_METHOD_1) ||
      tx?.data.startsWith(UPDATE_CLAIM_METHOD_2) ||
      tx?.data.startsWith(UPDATE_CLAIM_METHOD_3)
    ) {
      const data = tx.data;
      try {
        const parsed = NFT_HISTORY_IFACE.parseTransaction({
          data,
          value: 0
        });
        if (!parsed) {
          throw new Error('Failed to parse transaction');
        }
        const claimIndex =
          parsed.args.claimIndex != null
            ? Number(parsed.args.claimIndex)
            : Number(parsed.args.instanceId);
        const location = parsed.args.claimParameters.location;
        const contract = parsed.args.creatorContractAddress;
        const existingClaims = await findClaim(claimIndex);
        const nftId = existingClaims.find((c) => c.nft_id != -1)?.nft_id;
        if (existingClaims.length > 0) {
          if (nftId) {
            if (!existingClaims.some((c) => c.location == location)) {
              const editDescription = await getEditDescription(
                nftId,
                contract,
                `https://arweave.net/${location}`,
                tx.blockNumber!
              );
              if (editDescription) {
                const nftEdit: NFTHistory = {
                  created_at: new Date(),
                  nft_id: nftId,
                  contract: contract,
                  uri: `https://arweave.net/${location}`,
                  transaction_date: new Date(t.metadata.blockTimestamp),
                  transaction_hash: t.hash,
                  block: parseInt(t.blockNum, 16),
                  description: editDescription
                };
                await persistNftHistory([nftEdit]);
              }
            }
          }
        }
      } catch (e: any) {
        logger.error(`[ERROR PARSING TX ${tx.hash}] [${e}]`);
      }
    }
  }

  return {
    latestBlock: latestBlock,
    pageKey: assetResponse.pageKey
  };
};

export const findDeployerTransactions = async (
  startingBlock: number,
  latestBlock?: number,
  pageKey?: string
): Promise<number> => {
  const response = await getDeployerTransactions(
    startingBlock,
    latestBlock,
    pageKey
  );

  if (response.pageKey) {
    return await findDeployerTransactions(
      startingBlock,
      response.latestBlock,
      response.pageKey
    );
  } else {
    return response.latestBlock;
  }
};

export const findNFTHistory = async (
  force: boolean,
  startingBlock?: number,
  latestBlock?: number,
  pagKey?: string
) => {
  try {
    let startingBlockResolved: number;
    if (startingBlock == undefined) {
      startingBlockResolved = await fetchLatestNftHistoryBlockNumber();
      if (!startingBlockResolved || force) {
        startingBlockResolved = 0;
      }
    } else {
      startingBlockResolved = startingBlock;
    }

    const deployerTransactionsBlock = await findDeployerTransactions(
      startingBlockResolved,
      latestBlock,
      pagKey
    );

    await persistNftHistoryBlock(deployerTransactionsBlock);
  } catch (e: any) {
    logger.error(`[ETIMEDOUT!] [RETRYING PROCESS] [${e}]`);
    await findNFTHistory(force, startingBlock, latestBlock, pagKey);
  }
};
