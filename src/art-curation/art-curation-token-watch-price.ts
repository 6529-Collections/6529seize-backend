import { SEAPORT_IFACE } from '@/abis/seaport';
import { equalIgnoreCase } from '@/strings';
import { ethers } from 'ethers';

const TRANSFER_EVENT_TOPIC = ethers.id('Transfer(address,address,uint256)');
const OPENSEA_MATCH_EVENT =
  '0x4b9f2d36e1b4c93de62cc077b00b1a91d84b6c31b4a14e012718dcca230689e7';

const ItemType = {
  NATIVE: 0,
  ERC20: 1,
  ERC721: 2,
  ERC1155: 3,
  ERC721_WITH_CRITERIA: 4,
  ERC1155_WITH_CRITERIA: 5
} as const;

const ZERO_PRICE = {
  amountRaw: null,
  currency: null
} as const;

export interface ArtCurationTransferPricingTransaction {
  readonly from: string | null;
  readonly value: bigint | number | string | null | undefined;
}

export interface ArtCurationTransferPricingLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

export interface ArtCurationTransferPricingReceipt {
  readonly logs: readonly ArtCurationTransferPricingLog[];
}

export interface ArtCurationTransferPrice {
  readonly amountRaw: string | null;
  readonly currency: string | null;
}

type TokenPath = {
  firstFrom: string;
  finalTo: string;
};

type TokenRef = {
  contract: string;
  tokenId: string;
  amount: bigint;
};

type ConsiderationTokenRef = TokenRef & {
  recipient: string;
};

type OrderEvent = {
  orderHash: string;
  offerer: string;
  recipient: string;
  offerNfts: TokenRef[];
  considerationNfts: ConsiderationTokenRef[];
  currencySplits: Array<{
    itemType: number;
    token: string;
    amount: bigint;
    recipient: string;
  }>;
  currency: { itemType: number; token: string } | null;
  offerCurrencyTotal: bigint;
  considerationCurrencyTotal: bigint;
};

type SyntheticTransferRow = {
  contract: string;
  tokenId: string;
  fromAddress: string;
  toAddress: string;
};

export function getBestEffortArtCurationTransferPrice({
  transaction,
  receipt,
  contract,
  tokenId
}: {
  transaction: ArtCurationTransferPricingTransaction | null;
  receipt: ArtCurationTransferPricingReceipt | null;
  contract: string;
  tokenId: string;
}): ArtCurationTransferPrice {
  if (!receipt) {
    return ZERO_PRICE;
  }

  const tokenPath = getTokenPath({
    receipt,
    contract,
    tokenId
  });
  if (!tokenPath) {
    return ZERO_PRICE;
  }

  const syntheticRow: SyntheticTransferRow = {
    contract,
    tokenId,
    fromAddress: tokenPath.firstFrom,
    toAddress: tokenPath.finalTo
  };

  const seaportAttribution = attributeSeaportTransferPrice({
    receipt,
    row: syntheticRow
  });
  if (seaportAttribution) {
    return seaportAttribution;
  }

  return attributeGenericTransferPrice({
    transaction,
    receipt,
    contract,
    tokenId,
    buyer: tokenPath.finalTo
  });
}

function attributeSeaportTransferPrice({
  receipt,
  row
}: {
  receipt: ArtCurationTransferPricingReceipt;
  row: SyntheticTransferRow;
}): ArtCurationTransferPrice | null {
  const tokenMatch = (item: { contract: string; tokenId: string }) =>
    equalIgnoreCase(item.contract, row.contract) &&
    item.tokenId === row.tokenId;

  const orderEvents = parseSeaportOrderEvents(receipt);
  if (!orderEvents.length) {
    return null;
  }

  const hasOfferToken = (event: OrderEvent) => event.offerNfts.some(tokenMatch);
  const hasConsiderationToken = (event: OrderEvent) =>
    event.considerationNfts.some(tokenMatch);
  const hasConsiderationTokenForBuyer = (event: OrderEvent) =>
    event.considerationNfts.some(
      (item) =>
        tokenMatch(item) && equalIgnoreCase(item.recipient, row.toAddress)
    );

  const strictSeller = (event: OrderEvent) =>
    equalIgnoreCase(event.offerer, row.fromAddress) &&
    equalIgnoreCase(event.recipient, row.toAddress) &&
    hasOfferToken(event);
  const relaxedSeller = (event: OrderEvent) =>
    equalIgnoreCase(event.offerer, row.fromAddress) && hasOfferToken(event);
  const strictBid = (event: OrderEvent) =>
    equalIgnoreCase(event.offerer, row.toAddress) &&
    hasConsiderationTokenForBuyer(event) &&
    equalIgnoreCase(event.recipient, row.fromAddress);
  const relaxedBid = (event: OrderEvent) =>
    equalIgnoreCase(event.offerer, row.toAddress) &&
    hasConsiderationTokenForBuyer(event);
  const strictBuyer = (event: OrderEvent) =>
    equalIgnoreCase(event.recipient, row.toAddress) &&
    hasConsiderationToken(event);
  const relaxedBuyer = (event: OrderEvent) =>
    hasConsiderationToken(event) &&
    (equalIgnoreCase(event.offerer, row.fromAddress) ||
      equalIgnoreCase(event.recipient, row.toAddress));

  const lastResort = (): OrderEvent | undefined => {
    const matches = orderEvents.filter(
      (event) => hasOfferToken(event) || hasConsiderationToken(event)
    );
    return matches.length === 1 ? matches[0] : undefined;
  };

  const chosen =
    orderEvents.find(strictSeller) ??
    orderEvents.find(relaxedSeller) ??
    orderEvents.find(strictBid) ??
    orderEvents.find(relaxedBid) ??
    orderEvents.find(strictBuyer) ??
    orderEvents.find(relaxedBuyer) ??
    lastResort();

  if (!chosen) {
    return null;
  }

  let mergedCurrencySplits = chosen.currencySplits.slice();
  let mergedOfferNfts = chosen.offerNfts.slice();
  let mergedConsiderationNfts = chosen.considerationNfts.slice();
  let mergedCurrency = chosen.currency;
  let mergedOfferCurrencyTotal = chosen.offerCurrencyTotal;
  let mergedConsiderationCurrencyTotal = chosen.considerationCurrencyTotal;
  let matchedGroupDistinctTokenCount = 0;

  try {
    for (const log of receipt.logs) {
      if (!equalIgnoreCase(log.topics[0], OPENSEA_MATCH_EVENT)) {
        continue;
      }
      let parsedMatch: ethers.LogDescription | null = null;
      try {
        parsedMatch = SEAPORT_IFACE.parseLog(log);
      } catch {
        parsedMatch = null;
      }
      if (!parsedMatch || parsedMatch.name !== 'OrdersMatched') {
        continue;
      }
      const hashes = (parsedMatch.args.orderHashes as string[]) ?? [];
      if (
        !hashes.length ||
        !hashes.some((hash) => equalIgnoreCase(hash, chosen.orderHash))
      ) {
        continue;
      }

      const siblings = orderEvents.filter((event) =>
        hashes.some((hash) => equalIgnoreCase(hash, event.orderHash))
      );
      const siblingDistinctTokens = new Set(
        siblings
          .flatMap((event) => [...event.offerNfts, ...event.considerationNfts])
          .map((item) => `${item.contract.toLowerCase()}:${item.tokenId}`)
      );

      const relevantSiblings = siblings.filter(
        (event) =>
          event.offerNfts.some(tokenMatch) ||
          event.considerationNfts.some(tokenMatch)
      );

      if (!relevantSiblings.length) {
        break;
      }

      if (
        !relevantSiblings.some((event) =>
          equalIgnoreCase(event.orderHash, chosen.orderHash)
        )
      ) {
        relevantSiblings.push(chosen);
      }

      mergedCurrencySplits = [];
      mergedOfferNfts = [];
      mergedConsiderationNfts = [];
      mergedCurrency = chosen.currency;
      mergedOfferCurrencyTotal = BigInt(0);
      mergedConsiderationCurrencyTotal = BigInt(0);

      for (const sibling of relevantSiblings) {
        mergedOfferNfts.push(...sibling.offerNfts);
        mergedConsiderationNfts.push(...sibling.considerationNfts);
        mergedCurrency ??= sibling.currency;
        mergedCurrencySplits.push(...sibling.currencySplits);
        mergedOfferCurrencyTotal += sibling.offerCurrencyTotal;
        mergedConsiderationCurrencyTotal += sibling.considerationCurrencyTotal;
      }
      matchedGroupDistinctTokenCount = siblingDistinctTokens.size;
      break;
    }
  } catch {
    // Best effort only. Fall through to generic logic if exact marketplace
    // attribution cannot be completed safely.
  }

  const inOffer = mergedOfferNfts.some(tokenMatch);
  const groupNftItems =
    inOffer && mergedOfferNfts.length > 0
      ? mergedOfferNfts
      : mergedConsiderationNfts;
  const groupAllNftItems = [...mergedOfferNfts, ...mergedConsiderationNfts];
  const distinctTokens = new Set(
    groupAllNftItems.map(
      (item) => `${item.contract.toLowerCase()}:${item.tokenId}`
    )
  );
  const onlyThisToken =
    distinctTokens.size === 1 &&
    distinctTokens.has(`${row.contract.toLowerCase()}:${row.tokenId}`);

  const groupTotalUnits = groupNftItems.reduce(
    (acc, item) => acc + item.amount,
    BigInt(0)
  );
  const groupThisUnits = groupNftItems
    .filter(tokenMatch)
    .reduce((acc, item) => acc + item.amount, BigInt(0));

  if (groupTotalUnits === BigInt(0) || groupThisUnits === BigInt(0)) {
    return null;
  }

  let groupTotalCurrency =
    mergedOfferCurrencyTotal > mergedConsiderationCurrencyTotal
      ? mergedOfferCurrencyTotal
      : mergedConsiderationCurrencyTotal;

  try {
    if (mergedCurrency?.itemType === ItemType.ERC20) {
      const buyerOut = getBuyerErc20Outflow({
        receipt,
        buyer: row.toAddress,
        token: mergedCurrency.token,
        allowedRecipients: new Set(
          mergedCurrencySplits.map((split) => split.recipient.toLowerCase())
        )
      });
      if (
        matchedGroupDistinctTokenCount === 1 &&
        buyerOut > groupTotalCurrency
      ) {
        groupTotalCurrency = buyerOut;
      }
    }
  } catch {
    // Best effort only.
  }

  const valueWeiPart = onlyThisToken
    ? groupTotalCurrency
    : (groupTotalCurrency * groupThisUnits) / groupTotalUnits;

  if (valueWeiPart <= BigInt(0)) {
    return null;
  }

  return {
    amountRaw: valueWeiPart.toString(),
    currency: normalizeCurrency(mergedCurrency)
  };
}

function parseSeaportOrderEvents(
  receipt: ArtCurationTransferPricingReceipt
): OrderEvent[] {
  const orderEvents: OrderEvent[] = [];

  for (const log of receipt.logs) {
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = SEAPORT_IFACE.parseLog(log);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.name !== 'OrderFulfilled') {
      continue;
    }

    const offer = (parsed.args.offer as any[]) ?? [];
    const consideration = (parsed.args.consideration as any[]) ?? [];

    const offerNfts = offer
      .filter((item) => isNftItemType(Number(item.itemType)))
      .map<TokenRef>((item) => ({
        contract: String(item.token),
        tokenId: BigInt(item.identifier).toString(),
        amount: BigInt(item.amount)
      }));

    const considerationNfts = consideration
      .filter((item) => isNftItemType(Number(item.itemType)))
      .map<ConsiderationTokenRef>((item) => ({
        contract: String(item.token),
        tokenId: BigInt(item.identifier).toString(),
        amount: BigInt(item.amount),
        recipient: String(item.recipient)
      }));

    let offerCurrencyTotal = BigInt(0);
    let currency: { itemType: number; token: string } | null = null;
    for (const item of offer) {
      const itemType = Number(item.itemType);
      if (!isCurrencyItemType(itemType)) {
        continue;
      }
      offerCurrencyTotal += valueToWei(item.amount);
      currency ??= {
        itemType,
        token: String(item.token)
      };
    }

    const currencySplits: OrderEvent['currencySplits'] = [];
    for (const item of consideration) {
      const itemType = Number(item.itemType);
      if (!isCurrencyItemType(itemType)) {
        continue;
      }
      currency ??= {
        itemType,
        token: String(item.token)
      };
      currencySplits.push({
        itemType,
        token: String(item.token),
        amount: valueToWei(item.amount),
        recipient: String(item.recipient)
      });
    }

    orderEvents.push({
      orderHash: String(parsed.args.orderHash),
      offerer: String(parsed.args.offerer),
      recipient: String(parsed.args.recipient),
      offerNfts,
      considerationNfts,
      currencySplits,
      currency,
      offerCurrencyTotal,
      considerationCurrencyTotal: currencySplits.reduce(
        (acc, split) => acc + split.amount,
        BigInt(0)
      )
    });
  }

  return orderEvents;
}

function attributeGenericTransferPrice({
  transaction,
  receipt,
  contract,
  tokenId,
  buyer
}: {
  transaction: ArtCurationTransferPricingTransaction | null;
  receipt: ArtCurationTransferPricingReceipt;
  contract: string;
  tokenId: string;
  buyer: string;
}): ArtCurationTransferPrice {
  const distinctTokens = getDistinctTransferredTokens(receipt);
  const watchedTokenKey = `${contract.toLowerCase()}:${tokenId}`;
  if (distinctTokens.size !== 1 || !distinctTokens.has(watchedTokenKey)) {
    return ZERO_PRICE;
  }

  const transactionValue = valueToWei(transaction?.value);
  if (
    transactionValue > BigInt(0) &&
    transaction?.from &&
    equalIgnoreCase(transaction.from, buyer)
  ) {
    return {
      amountRaw: transactionValue.toString(),
      currency: ethers.ZeroAddress.toLowerCase()
    };
  }

  let selectedToken: string | null = null;
  let selectedAmount = BigInt(0);
  const erc20Outflows = new Map<string, bigint>();

  for (const log of receipt.logs) {
    if (
      log.topics.length !== 3 ||
      !equalIgnoreCase(log.topics[0], TRANSFER_EVENT_TOPIC) ||
      equalIgnoreCase(log.address, contract)
    ) {
      continue;
    }

    let from: string;
    let amount: bigint;
    try {
      from = decodeTopicAddress(log.topics[1]);
      amount = valueToWei(log.data);
    } catch {
      continue;
    }

    if (!equalIgnoreCase(from, buyer) || amount <= BigInt(0)) {
      continue;
    }

    const token = normalizeAddress(log.address);
    erc20Outflows.set(token, (erc20Outflows.get(token) ?? BigInt(0)) + amount);
  }

  erc20Outflows.forEach((amount, token) => {
    if (amount > selectedAmount) {
      selectedToken = token;
      selectedAmount = amount;
    }
  });

  if (!selectedToken || selectedAmount <= BigInt(0)) {
    return ZERO_PRICE;
  }

  return {
    amountRaw: selectedAmount.toString(),
    currency: selectedToken
  };
}

function getBuyerErc20Outflow({
  receipt,
  buyer,
  token,
  allowedRecipients
}: {
  receipt: ArtCurationTransferPricingReceipt;
  buyer: string;
  token: string;
  allowedRecipients: Set<string>;
}): bigint {
  let buyerOut = BigInt(0);
  for (const log of receipt.logs) {
    if (
      log.topics.length !== 3 ||
      !equalIgnoreCase(log.topics[0], TRANSFER_EVENT_TOPIC) ||
      !equalIgnoreCase(log.address, token)
    ) {
      continue;
    }

    let from: string;
    let to: string;
    let amount: bigint;
    try {
      from = decodeTopicAddress(log.topics[1]);
      to = decodeTopicAddress(log.topics[2]);
      amount = valueToWei(log.data);
    } catch {
      continue;
    }

    if (!equalIgnoreCase(from, buyer) || amount <= BigInt(0)) {
      continue;
    }
    if (
      allowedRecipients.size > 0 &&
      !allowedRecipients.has(to.toLowerCase())
    ) {
      continue;
    }
    buyerOut += amount;
  }
  return buyerOut;
}

function getTokenPath({
  receipt,
  contract,
  tokenId
}: {
  receipt: ArtCurationTransferPricingReceipt;
  contract: string;
  tokenId: string;
}): TokenPath | null {
  const tokenLogs = receipt.logs.filter((log) => {
    if (
      log.topics.length !== 4 ||
      !equalIgnoreCase(log.topics[0], TRANSFER_EVENT_TOPIC) ||
      !equalIgnoreCase(log.address, contract)
    ) {
      return false;
    }
    try {
      return BigInt(log.topics[3]).toString() === tokenId;
    } catch {
      return false;
    }
  });

  if (!tokenLogs.length) {
    return null;
  }

  return {
    firstFrom: decodeTopicAddress(tokenLogs[0].topics[1]),
    finalTo: decodeTopicAddress(tokenLogs[tokenLogs.length - 1].topics[2])
  };
}

function getDistinctTransferredTokens(
  receipt: ArtCurationTransferPricingReceipt
): Set<string> {
  const distinctTokens = new Set<string>();
  for (const log of receipt.logs) {
    if (
      log.topics.length !== 4 ||
      !equalIgnoreCase(log.topics[0], TRANSFER_EVENT_TOPIC)
    ) {
      continue;
    }
    try {
      distinctTokens.add(
        `${normalizeAddress(log.address)}:${BigInt(log.topics[3]).toString()}`
      );
    } catch {
      continue;
    }
  }
  return distinctTokens;
}

function normalizeCurrency(
  currency: { itemType: number; token: string } | null
): string | null {
  if (!currency) {
    return null;
  }
  if (currency.itemType === ItemType.NATIVE) {
    return ethers.ZeroAddress.toLowerCase();
  }
  return normalizeAddress(currency.token);
}

function isNftItemType(itemType: number): boolean {
  return (
    itemType === ItemType.ERC721 ||
    itemType === ItemType.ERC1155 ||
    itemType === ItemType.ERC721_WITH_CRITERIA ||
    itemType === ItemType.ERC1155_WITH_CRITERIA
  );
}

function isCurrencyItemType(itemType: number): boolean {
  return itemType === ItemType.NATIVE || itemType === ItemType.ERC20;
}

function decodeTopicAddress(topic: string): string {
  return normalizeAddress(`0x${topic.slice(-40)}`);
}

function normalizeAddress(address: string): string {
  try {
    return ethers.getAddress(address).toLowerCase();
  } catch {
    return address.toLowerCase();
  }
}

function valueToWei(value: unknown): bigint {
  if (value === null || value === undefined) {
    return BigInt(0);
  }
  if (typeof value === 'bigint') {
    return value;
  }
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
        return BigInt(maybeToString.call(value));
      } catch {
        return BigInt(0);
      }
    }
  }
  return BigInt(0);
}
