import {
  Alchemy,
  AssetTransfersCategory,
  AssetTransfersParams,
  fromHex,
  Network,
  Utils
} from 'alchemy-sdk';
import {
  ACK_DEPLOYER,
  ALCHEMY_SETTINGS,
  MANIFOLD,
  MEMELAB_CONTRACT,
  MEMELAB_ROYALTIES_ADDRESS,
  MEMES_DEPLOYER,
  NEXTGEN_CONTRACT,
  NEXTGEN_ROYALTIES_ADDRESS,
  NULL_ADDRESS,
  OPENSEA_ADDRESS,
  ROYALTIES_ADDRESS,
  TRANSACTIONS_TABLE,
  WETH_TOKEN_ADDRESS
} from '../constants';
import { Transaction } from '../entities/ITransaction';
import { areEqualAddresses } from '../helpers';
import { ethers } from 'ethers';
import { findTransactionsByHash } from '../db';
import { Logger } from '../logging';
import fetch from 'node-fetch';

const logger = Logger.get('TRANSACTION_VALUES');

const TRANSFER_EVENT =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const MINT_FROM_ADDRESS =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

let alchemy: Alchemy;
let SEAPORT_IFACE: any = undefined;

async function loadABIs() {
  const f = await fetch(
    `https://api.etherscan.io/api?module=contract&action=getabi&address=${OPENSEA_ADDRESS}&apikey=${process.env.ETHERSCAN_API_KEY}`
  );
  const abi = await f.json();
  SEAPORT_IFACE = new ethers.utils.Interface(abi.result);

  logger.info(`[ROYALTIES] [ABIs LOADED] [SEAPORT ${f.status}]`);
}

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
  return ethers.utils.getAddress(addressHex);
}

function resolveLogValue(data: string) {
  if (data === '0x') {
    return 0;
  }
  return parseFloat(Utils.formatEther(data));
}

export const findTransactionValues = async (
  transactions: Transaction[],
  network?: Network
) => {
  const settings = ALCHEMY_SETTINGS;
  if (network) {
    settings.network = network;
  }
  alchemy = new Alchemy({
    ...settings,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  if (!SEAPORT_IFACE) {
    await loadABIs();
  }

  logger.info(`[PROCESSING VALUES FOR ${transactions.length} TRANSACTIONS]`);

  const transactionsWithValues: Transaction[] = [];

  await Promise.all(
    transactions.map(async (t) => {
      const parsedTransaction = await resolveValue(t);
      transactionsWithValues.push(parsedTransaction);
    })
  );

  logger.info(
    `[PROCESSED ${transactionsWithValues.length} TRANSACTION VALUES]`
  );

  return transactionsWithValues;
};

async function resolveValue(t: Transaction) {
  const transaction = await alchemy.core.getTransaction(t.transaction);
  t.value = transaction ? parseFloat(Utils.formatEther(transaction.value)) : 0;
  t.royalties = 0;

  let royaltiesAddress = ROYALTIES_ADDRESS;
  if (areEqualAddresses(t.contract, MEMELAB_CONTRACT)) {
    royaltiesAddress = MEMELAB_ROYALTIES_ADDRESS;
  } else if (areEqualAddresses(t.contract, NEXTGEN_CONTRACT)) {
    royaltiesAddress = NEXTGEN_ROYALTIES_ADDRESS;
  }

  if (transaction) {
    const receipt = await alchemy.core.getTransactionReceipt(transaction?.hash);
    const logCount =
      receipt?.logs.filter(
        (l) =>
          areEqualAddresses(l.topics[0], TRANSFER_EVENT) &&
          areEqualAddresses(resolveLogAddress(l.topics[2]), t.to_address)
      ).length || 1;

    if (receipt?.gasUsed) {
      const gasUnits = receipt.gasUsed.toNumber();
      const gasPrice = parseFloat(Utils.formatEther(receipt.effectiveGasPrice));
      const gasPriceGwei =
        Math.round(gasPrice * 1000000000 * 100000000) / 100000000;
      const gas = Math.round(gasUnits * gasPrice * 100000000) / 100000000;

      t.gas_gwei = gasUnits;
      t.gas_price = gasPrice;
      t.gas_price_gwei = gasPriceGwei;
      t.gas = gas / logCount;
    }

    if (receipt) {
      let totalValue = 0;
      let totalRoyalties = 0;
      let seaportEvent = false;
      await Promise.all(
        receipt.logs.map(async (log) => {
          const parsedLog = await parseSeaportLog(t, royaltiesAddress, log);
          if (
            parsedLog &&
            parsedLog.tokenId == t.token_id &&
            areEqualAddresses(parsedLog.contract, t.contract)
          ) {
            t.royalties = parsedLog.royaltiesAmount;
            t.value = parsedLog.totalAmount;
            seaportEvent = true;
          } else {
            if (
              areEqualAddresses(log.topics[0], TRANSFER_EVENT) &&
              !seaportEvent
            ) {
              try {
                const address = log.address;
                if (areEqualAddresses(address, WETH_TOKEN_ADDRESS)) {
                  const from = resolveLogAddress(log.topics[1]);
                  const to = resolveLogAddress(log.topics[2]);
                  const value = resolveLogValue(log.data) / logCount;
                  if (areEqualAddresses(from, t.to_address)) {
                    totalValue += value;
                  }
                  if (areEqualAddresses(to, royaltiesAddress)) {
                    totalRoyalties += value;
                  }
                } else if (
                  areEqualAddresses(log.topics[1], MINT_FROM_ADDRESS)
                ) {
                  totalValue = t.value / logCount;
                  totalRoyalties = 0;
                }
              } catch (e) {
                logger.error(
                  `Error adding royalties for transaction ${t.transaction}`,
                  e
                );
              }
            }
          }
        })
      );
      if (totalValue) {
        t.value = totalValue;
        t.royalties = totalRoyalties;
      }
    }
  }

  if (
    areEqualAddresses(t.from_address, NULL_ADDRESS) ||
    areEqualAddresses(t.from_address, MANIFOLD) ||
    (areEqualAddresses(t.from_address, ACK_DEPLOYER) &&
      areEqualAddresses(t.contract, MEMELAB_CONTRACT) &&
      t.token_id == 12)
  ) {
    const block = `0x${t.block.toString(16)}`;
    const settings: AssetTransfersParams = {
      category: [AssetTransfersCategory.INTERNAL],
      excludeZeroValue: true,
      fromBlock: block,
      toBlock: block
    };

    const internlTrfs = await alchemy.core.getAssetTransfers(settings);
    const filteredInternalTrfs = internlTrfs.transfers.filter(
      (it) =>
        it.hash == t.transaction &&
        (areEqualAddresses(it.from, t.to_address) ||
          areEqualAddresses(it.from, MANIFOLD) ||
          (it.to && areEqualAddresses(it.to, MEMES_DEPLOYER)))
    );

    if (filteredInternalTrfs.length > 0) {
      let primaryProceeds = 0;
      filteredInternalTrfs.forEach((internalT) => {
        if (internalT?.value) {
          primaryProceeds += internalT.value;
        }
      });
      if (primaryProceeds) {
        t.primary_proceeds = primaryProceeds;
        t.value = primaryProceeds;
      }
    }

    if (!t.primary_proceeds) {
      t.primary_proceeds = t.value;
    }
  }

  t.value = parseFloat(t.value.toFixed(8));
  t.royalties = parseFloat(t.royalties.toFixed(8));
  t.primary_proceeds = parseFloat(t.primary_proceeds.toFixed(8));
  t.gas = parseFloat(t.gas.toFixed(8));
  t.gas_price = parseFloat(t.gas_price.toFixed(8));
  t.gas_price_gwei = parseFloat(t.gas_price_gwei.toFixed(8));
  t.gas_gwei = parseFloat(t.gas_gwei.toFixed(8));

  return t;
}

const parseSeaportLog = async (
  t: Transaction,
  royaltiesAddress: string,
  log: ethers.providers.Log
) => {
  let seaResult;
  try {
    seaResult = SEAPORT_IFACE.parseLog(log);
  } catch (err: any) {
    logger.debug(`SEAPORT PARSE ERROR for transaction ${t.transaction}`, err);
    return null;
  }

  let recipientConsideration = seaResult.args.consideration?.find((c: any) =>
    areEqualAddresses(c.recipient, t.from_address)
  );
  if (!recipientConsideration) {
    recipientConsideration = seaResult.args.offer?.find((o: any) =>
      areEqualAddresses(o.recipient, t.from_address)
    );
  }

  const royaltiesConsideration = seaResult.args.consideration?.find((c: any) =>
    areEqualAddresses(c.recipient, royaltiesAddress)
  );

  let tokenConsideration = seaResult.args.consideration?.find((o: any) =>
    areEqualAddresses(o.token, t.contract)
  );
  if (!tokenConsideration) {
    tokenConsideration = seaResult.args.offer?.find((o: any) =>
      areEqualAddresses(o.token, t.contract)
    );
  }

  if (tokenConsideration && recipientConsideration) {
    const contract = tokenConsideration.token;
    const tokenId = fromHex(tokenConsideration.identifier);
    const royaltiesAmount = royaltiesConsideration
      ? parseFloat(Utils.formatEther(royaltiesConsideration.amount))
      : 0;

    let totalAmount = 0;

    seaResult.args.offer
      .filter((o: any) => !areEqualAddresses(o.token, t.contract))
      .map((o: any) => {
        totalAmount += parseFloat(Utils.formatEther(o.amount));
      });

    if (totalAmount == 0) {
      seaResult.args.consideration
        .filter((o: any) => !areEqualAddresses(o.token, contract))
        .map((o: any) => {
          totalAmount += parseFloat(Utils.formatEther(o.amount));
        });
    }

    return {
      contract,
      tokenId,
      royaltiesAmount,
      totalAmount
    };
  }
};

// HELPER FUNCTION FOR DEBUGGING VALUES USING TRX HASHES FROM DB
export const debugValues = async () => {
  if (!alchemy) {
    alchemy = new Alchemy({
      ...ALCHEMY_SETTINGS,
      apiKey: process.env.ALCHEMY_API_KEY
    });
  }

  if (!SEAPORT_IFACE) {
    await loadABIs();
  }

  // SAMPLE TRX HASHES
  const transactions = [
    '0xfca058600347480cb759890182328dc11034e5c135b7d51f2d67dbc9774e674f',
    '0xf7982454b13c4837058f8efadc0794239b281d2d473817d3edfbce2520114e44',
    '0x3a79990d01b87d77741227a81db0201b31d2e711aefff943c086d2bbc90a0605',
    '0x0010dcbac1dcdebd2f4186342dda88ec8889bf0ffb9445b7598ec0172d671b07',
    '0x4144495f6932b53d48469b76876a82ffa0172d69dc9fc69f2120444b6df2a1b7',
    '0xdf73c5f14da545c5da2d86e9f9b9733541a003609374c456d7c3badad234b16a',
    '0x308577a5a108cc64633513215302ad1400b1018a593128fe53552216adc8fc6c',
    '0xe7d7748edd1228ca665e40e5b9792e5ef0a7a16606c18ef11851db435f2b43af',
    '0x00027d17a0f851a56dca8c469fd70b0d23dca2e3d2b4ebdad2f7e09ccb909405'
  ];

  await Promise.all(
    transactions.map(async (transactionHash) => {
      const tr = await findTransactionsByHash(TRANSACTIONS_TABLE, [
        transactionHash
      ]);

      let totalValue = 0;
      let totalPrimaryProceeds = 0;
      let totalRoyalties = 0;
      for (const t of tr) {
        const parsedTransaction = await resolveValue(t);
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
