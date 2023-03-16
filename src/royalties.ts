import {
  ALCHEMY_SETTINGS,
  GRADIENT_CONTRACT,
  MEMES_CONTRACT,
  OPENSEA_ADDRESS,
  ROYALTIES_ADDRESS
} from './constants';
import {
  Alchemy,
  AssetTransfersCategory,
  AssetTransfersWithMetadataParams,
  AssetTransfersWithMetadataResult,
  fromHex,
  Utils
} from 'alchemy-sdk';
import { areEqualAddresses } from './helpers';
import { Royalties } from './entities/IRoyalties';
import { NFT } from './entities/INFT';
import { fetchAllNFTs, persistRoyalties, persistRoyaltiesUpload } from './db';
import converter from 'json-2-csv';
import { ethers } from 'ethers';

const EthDater = require('ethereum-block-by-date');
const fetch = require('node-fetch');

let alchemy: Alchemy;
const Arweave = require('arweave');

let SEAPORT_IFACE: any = undefined;

function addRoyalty(
  royalties: Royalties[],
  nfts: NFT[],
  royaltiesDate: Date,
  contract: string,
  tokenId: number,
  royaltyValue: number
) {
  const rExists = royalties.find(
    (ro) => areEqualAddresses(ro.contract, contract) && ro.token_id == tokenId
  );
  if (rExists) {
    rExists.received_royalties += royaltyValue;
  } else {
    const mynft = nfts.find(
      (n) => areEqualAddresses(contract, n.contract) && tokenId == n.id
    );
    const royalty: Royalties = {
      date: royaltiesDate,
      contract: contract,
      token_id: tokenId,
      artist: mynft ? mynft.artist : '',
      received_royalties: royaltyValue
    };
    royalties.push(royalty);
  }
  return royalties;
}

async function loadSeaport() {
  fetch(
    `https://api.etherscan.io/api?module=contract&action=getabi&address=${OPENSEA_ADDRESS}`
  ).then(async (res: any) => {
    const abi = await res.json();
    SEAPORT_IFACE = new ethers.utils.Interface(abi.result);
    console.log('[ROYALTIES]', `[SEAPORT LOADED]`);
  });
}

loadSeaport();

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

  console.log(
    '[ROYALTIES]',
    `[ROYALTIES TRANSACTIONS ${royaltiesTransactions.length}]`
  );

  let royalties: Royalties[] = [];

  const nfts: NFT[] = await fetchAllNFTs();

  if (!SEAPORT_IFACE) {
    await loadSeaport();
  }

  await Promise.all(
    royaltiesTransactions.map(async (rt) => {
      const receipt = await alchemy.core.getTransaction(rt.hash);

      if (receipt?.data) {
        try {
          const seaResult = SEAPORT_IFACE.parseTransaction({
            data: receipt.data
          });

          if (seaResult.name.startsWith('fulfillBasic')) {
            const params = seaResult.args.parameters;
            const contract = params.considerationToken;
            const tokenId = fromHex(params.considerationIdentifier);
            const value = parseFloat(Utils.formatEther(params.offerAmount));
            params.additionalRecipients
              .filter((ar: any) =>
                areEqualAddresses(ar.recipient, ROYALTIES_ADDRESS)
              )
              .map((ar: any) => {
                const royaltyValue = parseFloat(Utils.formatEther(ar.amount));
                royalties = addRoyalty(
                  royalties,
                  nfts,
                  royaltiesDate,
                  contract,
                  tokenId,
                  royaltyValue
                );
              });
          } else if (seaResult.name.startsWith('fulfillAdvanced') && rt.value) {
            const seaResult = SEAPORT_IFACE.parseTransaction({
              data: receipt.data
            });
            const args = seaResult.args[0];
            const offer = args.parameters.offer[0];
            const contract = offer.token;
            const tokenId = fromHex(offer.identifierOrCriteria);
            royalties = addRoyalty(
              royalties,
              nfts,
              royaltiesDate,
              contract,
              tokenId,
              rt.value
            );
          } else if (seaResult.name.startsWith('fulfillAvailable')) {
            const args = seaResult.args[0];
            args.map((arg: any) => {
              const contract = arg.parameters.offer[0].token;
              const tokenId = fromHex(
                arg.parameters.offer[0].identifierOrCriteria
              );
              const considerations = arg.parameters.consideration;
              let royaltyValue = 0;
              considerations.map((cons: any) => {
                if (areEqualAddresses(cons.recipient, ROYALTIES_ADDRESS)) {
                  royaltyValue += parseFloat(Utils.formatEther(cons.endAmount));
                }
              });
              if (royaltyValue) {
                royalties = addRoyalty(
                  royalties,
                  nfts,
                  royaltiesDate,
                  contract,
                  tokenId,
                  royaltyValue
                );
              }
            });
          } else {
            console.log('i am something else', seaResult.name, rt.hash);
          }
        } catch (err: any) {
          console.log(
            'i am error',
            rt.hash,
            rt.value,
            receipt.blockNumber,
            receipt.from,
            receipt.to
          );
          const allTransfers = await alchemy.core.getAssetTransfers({
            fromAddress: receipt.from,
            toAddress: receipt.to,
            withMetadata: true,
            fromBlock: `0x${receipt.blockNumber!.toString(16)}`,
            toBlock: `0x${receipt.blockNumber!.toString(16)}`,
            contractAddresses: [MEMES_CONTRACT, GRADIENT_CONTRACT],
            category: [
              AssetTransfersCategory.ERC1155,
              AssetTransfersCategory.ERC721
            ]
          });
          console.log(allTransfers);
          const royaltyTransfer = allTransfers.transfers.find((tr) =>
            areEqualAddresses(tr.hash, rt.hash)
          );
          console.log(royaltyTransfer);

          let totalTokenCount = 1;
          if (royaltyTransfer && royaltyTransfer.erc1155Metadata) {
            totalTokenCount = [...royaltyTransfer.erc1155Metadata].reduce(
              (accumulator, object) => {
                if (object.value) {
                  return accumulator + fromHex(object.value);
                }
                return accumulator;
              },
              1
            );
          }

          if (
            royaltyTransfer?.erc721TokenId &&
            royaltyTransfer.rawContract.address &&
            rt.value
          ) {
            royalties = addRoyalty(
              royalties,
              nfts,
              royaltiesDate,
              royaltyTransfer.rawContract.address!,
              fromHex(royaltyTransfer?.erc721TokenId),
              rt.value / totalTokenCount
            );
          }

          if (
            royaltyTransfer?.erc1155Metadata &&
            royaltyTransfer.rawContract.address &&
            rt.value
          ) {
            console.log(rt.hash, totalTokenCount, rt.value);
            royaltyTransfer?.erc1155Metadata.map((meta) => {
              royalties = addRoyalty(
                royalties,
                nfts,
                royaltiesDate,
                royaltyTransfer.rawContract.address!,
                fromHex(meta.tokenId),
                rt.value! / totalTokenCount
              );
            });
          }
        }
      }
    })
  );

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
