import {
  Alchemy,
  AssetTransfersCategory,
  AssetTransfersParams,
  Network,
  Utils
} from 'alchemy-sdk';
import { ethers } from 'ethers';
import { SEAPORT_IFACE } from './abis/seaport';
import {
  ACK_DEPLOYER,
  ALCHEMY_SETTINGS,
  MANIFOLD,
  MEMELAB_CONTRACT,
  MEMELAB_ROYALTIES_ADDRESS,
  MEMES_DEPLOYER,
  NULL_ADDRESS,
  ROYALTIES_ADDRESS,
  TRANSACTIONS_TABLE,
  WETH_TOKEN_ADDRESS
} from './constants';
import { findTransactionsByHash } from './db';
import { Transaction } from './entities/ITransaction';
import { getClosestEthUsdPrice } from './ethPriceLoop/db.eth_price';
import { Logger } from './logging';
import {
  getNextgenNetwork,
  NEXTGEN_CORE_CONTRACT,
  NEXTGEN_ROYALTIES_ADDRESS
} from './nextgen/nextgen_constants';
import { equalIgnoreCase } from './strings';

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

let alchemy: Alchemy;

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
  if (equalIgnoreCase(t.contract, MEMELAB_CONTRACT)) {
    royaltiesAddress = MEMELAB_ROYALTIES_ADDRESS;
  } else if (
    equalIgnoreCase(t.contract, NEXTGEN_CORE_CONTRACT[getNextgenNetwork()])
  ) {
    royaltiesAddress = NEXTGEN_ROYALTIES_ADDRESS;
  }

  if (transaction) {
    const receipt = await alchemy.core.getTransactionReceipt(transaction?.hash);
    const logCount =
      receipt?.logs.filter(
        (l) =>
          equalIgnoreCase(l.topics[0], TRANSFER_EVENT) &&
          equalIgnoreCase(resolveLogAddress(l.topics[2]), t.to_address)
      ).length || 1;

    if (receipt?.gasUsed) {
      const gasUnits = Number(receipt.gasUsed);
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
      const attributeRow = attributeRowFromSeaportTx(
        receipt,
        t,
        royaltiesAddress
      );

      if (attributeRow) {
        t.royalties = attributeRow.royalties;
        t.value = attributeRow.value;
      } else {
        let totalValue = 0;
        let totalRoyalties = 0;

        await Promise.all(
          receipt.logs.map(async (log) => {
            if (isBlurEvent(log)) {
              const royaltiesResponse = await parseBlurLog(log);
              if (
                royaltiesResponse &&
                equalIgnoreCase(
                  royaltiesResponse.feeRecipient,
                  royaltiesAddress
                )
              ) {
                const parsedRate = Number(royaltiesResponse.feeRate);
                const parsedRatePercentage = parsedRate / 100;
                const royaltiesAmount = t.value * (parsedRatePercentage / 100);
                t.royalties = royaltiesAmount;
              }
            } else if (equalIgnoreCase(log.topics[0], TRANSFER_EVENT)) {
              try {
                const address = log.address;
                if (equalIgnoreCase(address, WETH_TOKEN_ADDRESS)) {
                  const from = resolveLogAddress(log.topics[1]);
                  const to = resolveLogAddress(log.topics[2]);
                  const value = resolveLogValue(log.data) / logCount;
                  if (equalIgnoreCase(from, t.to_address)) {
                    totalValue += value;
                  }
                  if (equalIgnoreCase(to, royaltiesAddress)) {
                    totalRoyalties += value;
                  }
                } else if (equalIgnoreCase(log.topics[1], MINT_FROM_ADDRESS)) {
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
          })
        );
        if (totalValue) {
          t.value = totalValue;
        }
        if (totalRoyalties) {
          t.royalties = totalRoyalties;
        }
      }
    }
  }

  if (
    equalIgnoreCase(t.from_address, NULL_ADDRESS) ||
    equalIgnoreCase(t.from_address, MANIFOLD) ||
    (equalIgnoreCase(t.from_address, ACK_DEPLOYER) &&
      equalIgnoreCase(t.contract, MEMELAB_CONTRACT) &&
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
        (equalIgnoreCase(it.from, t.to_address) ||
          equalIgnoreCase(it.from, MANIFOLD) ||
          (it.to && equalIgnoreCase(it.to, MEMES_DEPLOYER)))
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

  const ethPrice = await getClosestEthUsdPrice(new Date(t.transaction_date));
  t.eth_price_usd = ethPrice;
  t.value_usd = t.value * ethPrice;
  t.gas_usd = t.gas * ethPrice;

  return t;
}

const isSeaportEvent = (receipt: { logs: { topics: string[] }[] }) => {
  return receipt.logs.some((log) =>
    equalIgnoreCase(log.topics[0], OPENSEA_EVENT)
  );
};

const parseSeaportLog = async (
  t: Transaction,
  royaltiesAddress: string,
  log: { topics: string[]; data: string; address: string }
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
      (acc: number, c: any) => acc + parseFloat(Utils.formatEther(c.amount)),
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
        ? parseFloat(Utils.formatEther(royalties.amount))
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

    const totalAmount = parseFloat(Utils.formatEther(offer.amount));

    return {
      orderHash: seaResult.args.orderHash,
      contract: t.contract,
      tokenId: t.token_id,
      royaltiesAmount: royalties
        ? parseFloat(Utils.formatEther(royalties.amount))
        : 0,
      totalAmount: totalAmount
    };
  }
};

const isBlurEvent = (log: { topics: string[] }) => {
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
  if (!alchemy) {
    alchemy = new Alchemy({
      ...ALCHEMY_SETTINGS,
      apiKey: process.env.ALCHEMY_API_KEY
    });
  }

  // SAMPLE TRX HASHES
  const transactions = [
    '0x68896a9377b8bb04c50d6952006317f3c85971f80a2def180853798c4ab5556b'
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

      let totalValue = 0;
      let totalRoyalties = 0;
      let totalPrimaryProceeds = 0;

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
  receipt: { logs: { topics: string[]; data: string; address: string }[] },
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
        amount: c.amount as bigint
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
      const amt = BigInt(c.amount.toString());
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
  // Try seller-side first (NFT in offer[], offerer === from, recipient === to), then seller-side loose, then buyer-side strict, then buyer-side loose, then fallback.
  const tok = row.contract;
  const idStr = row.token_id.toString();
  const edgeFrom = row.from_address;
  const edgeTo = row.to_address;

  // token matchers
  const tokenMatch = (i: { contract: string; tokenId: string }) =>
    equalIgnoreCase(i.contract, tok) && i.tokenId === idStr;

  const hasOfferToken = (e: OrderEvt) => e.offerNfts.some(tokenMatch);
  const hasConsToken = (e: OrderEvt) => e.considerationNfts.some(tokenMatch);

  // predicates in your original priority order
  const strictSeller = (e: OrderEvt) =>
    equalIgnoreCase(e.offerer, edgeFrom) &&
    equalIgnoreCase(e.recipient, edgeTo) &&
    hasOfferToken(e);

  const relaxedSeller = (e: OrderEvt) =>
    equalIgnoreCase(e.offerer, edgeFrom) && hasOfferToken(e);

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
  // that lands at the actual buyer (the OrderFulfilled.recipient).
  // If we can see an NFT transfer that ends at the recipient for this token,
  // we require the current row to match that edge; otherwise, we skip attribution
  // for the operator hop to avoid double counting.
  try {
    const tokenEdgesForTx = nftEdges.filter(
      (e) =>
        equalIgnoreCase(e.contract, row.contract) &&
        e.tokenId === row.token_id.toString()
    );
    const buyerEdge = tokenEdgesForTx.find((e) =>
      equalIgnoreCase(e.to, chosen.recipient)
    );
    if (buyerEdge) {
      // There is an explicit transfer to the buyer in this tx for this token.
      // Only attribute to the row that ends at the buyer; skip seller->operator leg.
      if (!equalIgnoreCase(row.to_address, chosen.recipient)) {
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
          (mergedCurrencySplits as any)._matchedGroupDistinctTokenCount =
            siblingsAllDistinctTokens.size;
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
      let buyerOut = BigInt(0);
      for (const lg of receipt.logs) {
        if (
          lg.topics &&
          lg.topics.length === 3 &&
          lg.topics[0] === erc20TransferTopic &&
          equalIgnoreCase(lg.address, mergedCurrency.token)
        ) {
          const from = ethers.getAddress('0x' + lg.topics[1].slice(26));
          if (equalIgnoreCase(from, row.to_address)) {
            // amount is in data for ERC20 Transfer
            const amt = BigInt(lg.data);
            buyerOut += amt;
          }
        }
      }
      // Only apply buyer-outflow fallback when the matched group effectively involved ONE token total (no sweep/bundle).
      const matchedGroupDistinctTokenCount: number =
        (mergedCurrencySplits as any)._matchedGroupDistinctTokenCount ?? 0;
      const safeToOverride = matchedGroupDistinctTokenCount === 1;
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
    value: parseFloat(Utils.formatEther(valueWeiPart)),
    royalties: parseFloat(Utils.formatEther(royaltiesWeiPart)),
    currency: mergedCurrency,
    orderHash: chosen.orderHash
  };
}
