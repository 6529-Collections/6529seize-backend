import {
  ALCHEMY_SETTINGS,
  GRADIENT_CONTRACT,
  MEMES_CONTRACT,
  ROYALTIES_ADDRESS
} from './constants';
import {
  Alchemy,
  AssetTransfersCategory,
  AssetTransfersWithMetadataParams,
  AssetTransfersWithMetadataResult
} from 'alchemy-sdk';
import { areEqualAddresses } from './helpers';
import { Royalties } from './entities/IRoyalties';
import { NFT } from './entities/INFT';
import { fetchAllNFTs, persistRoyalties, persistRoyaltiesUpload } from './db';
import converter from 'json-2-csv';

const EthDater = require('ethereum-block-by-date');

let alchemy: Alchemy;
const Arweave = require('arweave');

const myarweave = Arweave.init({
  host: 'arweave.net',
  port: 443,
  protocol: 'https'
});

const findRoyaltiesAddressTransactionsForPage = async (
  alchemy: Alchemy,
  startingBlockHex: string,
  endingBlockHex: string,
  pageKey: any
) => {
  const settings: AssetTransfersWithMetadataParams = {
    category: [
      AssetTransfersCategory.ERC20,
      AssetTransfersCategory.INTERNAL,
      AssetTransfersCategory.EXTERNAL
    ],
    excludeZeroValue: true,
    withMetadata: true,
    maxCount: 250,
    fromBlock: startingBlockHex,
    toBlock: endingBlockHex,
    toAddress: ROYALTIES_ADDRESS
  };

  if (pageKey) {
    settings.pageKey = pageKey;
  }

  const response = await alchemy.core.getAssetTransfers(settings);
  return response;
};

const findRoyaltiesAddressTransactions = async (
  alchemy: Alchemy,
  startingBlockHex: string,
  endingBlockHex: string,
  transfers: AssetTransfersWithMetadataResult[] = [],
  pageKey: string = ''
): Promise<AssetTransfersWithMetadataResult[]> => {
  const response = await findRoyaltiesAddressTransactionsForPage(
    alchemy,
    startingBlockHex,
    endingBlockHex,
    pageKey
  );

  const newKey = response.pageKey;
  transfers = transfers.concat(response.transfers);

  if (newKey) {
    return findRoyaltiesAddressTransactions(
      alchemy,
      startingBlockHex,
      endingBlockHex,
      transfers,
      pageKey
    );
  }

  return transfers;
};

const findAssetTransfersForPage = async (
  alchemy: Alchemy,
  startingBlockHex: string,
  endingBlockHex: string,
  pageKey: any
) => {
  const settings: AssetTransfersWithMetadataParams = {
    category: [AssetTransfersCategory.ERC1155, AssetTransfersCategory.ERC721],
    contractAddresses: [MEMES_CONTRACT, GRADIENT_CONTRACT],
    withMetadata: true,
    fromBlock: startingBlockHex,
    toBlock: endingBlockHex
  };

  if (pageKey) {
    settings.pageKey = pageKey;
  }

  const response = await alchemy.core.getAssetTransfers(settings);
  return response;
};

const findAssetTransfers = async (
  alchemy: Alchemy,
  startingBlockHex: string,
  endingBlockHex: string,
  transfers: AssetTransfersWithMetadataResult[] = [],
  pageKey: string = ''
): Promise<AssetTransfersWithMetadataResult[]> => {
  const response = await findAssetTransfersForPage(
    alchemy,
    startingBlockHex,
    endingBlockHex,
    pageKey
  );

  const newKey = response.pageKey;
  transfers = transfers.concat(response.transfers);

  if (newKey) {
    return findAssetTransfers(
      alchemy,
      startingBlockHex,
      endingBlockHex,
      transfers,
      pageKey
    );
  }

  return transfers;
};

function getDate() {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setUTCDate(today.getUTCDate() - 2);

  yesterday.setUTCMonth(today.getUTCMonth());
  yesterday.setUTCFullYear(today.getUTCFullYear());
  return yesterday;
}

export const findRoyalties = async () => {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  const royaltiesDate = getDate();

  const provider = await alchemy.config.getProvider();
  const dater = new EthDater(provider);

  const date = new Date(royaltiesDate);
  const start = date.setUTCHours(0, 0, 0);
  const end = date.setUTCHours(23, 59, 59);

  const startingBlock = await dater.getDate(start, true);
  const endingBlock = await dater.getDate(end, false);

  console.log(
    '[ROYALTIES]',
    `[START BLOCK ${startingBlock.block} - ${new Date(
      startingBlock.timestamp * 1000
    ).toUTCString()}]`,
    `[END BLOCK ${endingBlock.block} - ${new Date(
      endingBlock.timestamp * 1000
    ).toUTCString()}]`
  );

  const startingBlockHex = `0x${startingBlock.block.toString(16)}`;
  const endingBlockHex = `0x${endingBlock.block.toString(16)}`;

  const royaltiesTransactions: AssetTransfersWithMetadataResult[] =
    await findRoyaltiesAddressTransactions(
      alchemy,
      startingBlockHex,
      endingBlockHex
    );

  const assetTransfers: AssetTransfersWithMetadataResult[] =
    await findAssetTransfers(alchemy, startingBlockHex, endingBlockHex);

  console.log(
    '[ROYALTIES]',
    `[ROYALTIES TRANSACTIONS ${royaltiesTransactions.length}]`,
    `[ASSET TRANSFERS ${assetTransfers.length}]`
  );

  const royalties: Royalties[] = [];

  const nfts: NFT[] = await fetchAllNFTs();

  royaltiesTransactions.map((rt) => {
    const trf = assetTransfers.find((at) =>
      areEqualAddresses(rt.hash, at.hash)
    );
    if (trf && rt.value) {
      let tokenId: number | null = null;
      if (trf.erc721TokenId) {
        tokenId = parseInt(trf.erc721TokenId, 16);

        const rExists = royalties.find(
          (ro) =>
            areEqualAddresses(ro.contract, trf.rawContract.address!) &&
            ro.token_id == tokenId
        );
        if (rExists) {
          rExists.received_royalties += rt.value;
        } else {
          const mynft = nfts.find(
            (n) =>
              areEqualAddresses(trf.rawContract.address!, n.contract) &&
              tokenId == n.id
          );
          const royalty: Royalties = {
            date: royaltiesDate,
            contract: trf.rawContract.address!,
            token_id: tokenId,
            artist: mynft ? mynft.artist : '',
            received_royalties: parseFloat(rt.value!.toFixed(10))
          };
          royalties.push(royalty);
        }
      } else if (trf.erc1155Metadata) {
        trf.erc1155Metadata.map((md) => {
          tokenId = parseInt(md.tokenId, 16);

          const rExists = royalties.find(
            (ro) =>
              areEqualAddresses(ro.contract, trf.rawContract.address!) &&
              ro.token_id == tokenId
          );
          if (rExists) {
            rExists.received_royalties += parseFloat(rt.value!.toFixed(10));
          } else {
            const mynft = nfts.find(
              (n) =>
                areEqualAddresses(trf.rawContract.address!, n.contract) &&
                tokenId == n.id
            );
            const royalty: Royalties = {
              date: royaltiesDate,
              contract: trf.rawContract.address!,
              token_id: tokenId,
              artist: mynft ? mynft.artist : '',
              received_royalties: parseFloat(rt.value!.toFixed(10))
            };
            royalties.push(royalty);
          }
        });
      }
    }
  });

  await persistRoyalties(royalties);

  // const url = await uploadRoyalties(royaltiesDate, royalties);
  // await persistRoyaltiesUpload(royaltiesDate, url);
};

async function uploadRoyalties(royaltiesDate: Date, royalties: Royalties[]) {
  const year = royaltiesDate.getFullYear();
  const month = ('0' + (royaltiesDate.getMonth() + 1)).slice(-2);
  const day = ('0' + royaltiesDate.getDate()).slice(-2);
  const formattedDate = `${year}-${month}-${day}`;

  const uploadArray: any[] = [];
  royalties.map((r) => {
    const uploadRoyalty: any = r;
    uploadRoyalty.date = formattedDate;
    delete uploadRoyalty.created_at;
    delete uploadRoyalty.id;
    uploadArray.push(uploadRoyalty);
  });

  uploadArray.sort((a, b) => {
    if (a.contract < b.contract) {
      return 1;
    }
    if (a.contract > b.contract) {
      return -1;
    }
    if (a.token_id < b.token_id) {
      return 1;
    }
    if (a.token_id > b.token_id) {
      return -1;
    }
    return 0;
  });

  const csv = await converter.json2csvAsync(uploadArray);

  const arweaveKey = process.env.ARWEAVE_KEY
    ? JSON.parse(process.env.ARWEAVE_KEY)
    : {};

  let transaction = await myarweave.createTransaction(
    { data: Buffer.from(csv) },
    arweaveKey
  );

  transaction.addTag('Content-Type', 'text/csv');

  console.log(
    new Date(),
    `[ROYALTIES UPLOAD]`,
    `[SIGNING ARWEAVE TRANSACTION]`
  );

  await myarweave.transactions.sign(transaction, arweaveKey);

  let uploader = await myarweave.transactions.getUploader(transaction);

  while (!uploader.isComplete) {
    await uploader.uploadChunk();
    console.log(
      '[ROYALTIES UPLOAD]',
      `${uploader.pctComplete}% complete, ${uploader.uploadedChunks}/${uploader.totalChunks}`
    );
  }

  const url = `https://arweave.net/${transaction.id}`;
  return url;
}
