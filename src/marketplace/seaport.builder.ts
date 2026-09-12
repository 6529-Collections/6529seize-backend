import {
  Interface,
  randomBytes,
  hexlify,
  verifyTypedData,
  TypedDataEncoder
} from 'ethers';
import { z } from 'zod';
import { validateMarketCriteria } from '@/marketplace/seaport-criteria';
import {
  MarketOrderIdentity,
  MarketTradeIntent,
  MarketTransaction,
  MarketValidationError,
  PreparedOrder,
  SeaportOrderComponents,
  ValidatedMarketOrder
} from '@/marketplace/provider.types';
import {
  MARKET_OPENSEA_CONDUIT_KEY,
  MARKET_OPENSEA_ZONE,
  MARKET_SEAPORT,
  MARKET_ZERO_ADDRESS,
  MARKET_ZERO_HASH,
  assertMarketProtocol,
  marketSpender
} from '@/marketplace/seaport.registry';
import {
  marketBytesSchema,
  marketOrderComponentsSchema,
  parseMarketValue,
  SEAPORT_COMPONENTS_TUPLE,
  SEAPORT_ORDER_TYPES,
  SEAPORT_PARAMETERS_TUPLE
} from '@/marketplace/seaport.schema';
import {
  assertMarketIntent,
  sameMarketAddress,
  validateMarketOrder
} from '@/marketplace/quote-validation';

export const MARKET_SEAPORT_INTERFACE = new Interface([
  `function fulfillAdvancedOrder((${SEAPORT_PARAMETERS_TUPLE} parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData) advancedOrder,(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[] criteriaResolvers,bytes32 fulfillerConduitKey,address recipient) payable returns (bool fulfilled)`,
  `function cancel(${SEAPORT_COMPONENTS_TUPLE}[] orders) returns (bool cancelled)`
]);

/** Deterministic economics; only counter and fresh cryptographic salt are external inputs. */
export function buildMarketOrder(
  intent: MarketTradeIntent,
  counter: string,
  salt = BigInt(hexlify(randomBytes(32))).toString()
): PreparedOrder {
  const i = assertMarketIntent(intent);
  if (!['LIST', 'OFFER'].includes(i.kind))
    throw new MarketValidationError(
      'INVALID_INTENT',
      'Only a listing or offer can create a signed order.'
    );
  const listing = i.kind === 'LIST';
  const feeTotal = i.fees.reduce(
    (sum, fee) => sum + BigInt(fee.amountWei),
    BigInt(0)
  );
  const item = (
    itemType: number,
    token: string,
    id: string,
    amount: string
  ) => ({
    itemType,
    token,
    identifierOrCriteria: id,
    startAmount: amount,
    endAmount: amount
  });
  const currencyType = sameMarketAddress(i.currency, MARKET_ZERO_ADDRESS)
    ? 0
    : 1;
  const nft = item(
    i.asset.standard === 'ERC721' ? 2 : 3,
    i.asset.contract,
    i.asset.tokenId,
    i.quantity
  );
  const fees = i.fees.map((fee) => ({
    ...item(currencyType, i.currency, '0', fee.amountWei),
    recipient: fee.recipient
  }));
  const components: SeaportOrderComponents = {
    offerer: i.wallet,
    zone: listing ? MARKET_ZERO_ADDRESS : MARKET_OPENSEA_ZONE,
    offer: [listing ? nft : item(1, i.currency, '0', i.maxTotalWei)],
    consideration: listing
      ? [
          {
            ...item(
              currencyType,
              i.currency,
              '0',
              (BigInt(i.maxTotalWei) - feeTotal).toString()
            ),
            recipient: i.wallet
          },
          ...fees
        ]
      : [{ ...nft, recipient: i.recipient }, ...fees],
    // Exact full fills avoid untested per-fee division of a newly created multi-unit order.
    orderType: listing ? 0 : 2,
    startTime: i.startTime!,
    endTime: i.endTime!,
    zoneHash: MARKET_ZERO_HASH,
    salt,
    conduitKey: MARKET_OPENSEA_CONDUIT_KEY,
    counter
  };
  return {
    kind: 'SIGN_ORDER',
    chainId: 1,
    from: i.wallet,
    order: validateMarketOrder(i, components)
  };
}

export function validateMarketTypedData(
  intent: MarketTradeIntent,
  input: unknown
): PreparedOrder {
  const schema = z
    .object({
      domain: z
        .object({
          name: z.literal('Seaport'),
          version: z.literal('1.6'),
          chainId: z.literal(1),
          verifyingContract: z.string()
        })
        .strict(),
      primaryType: z.literal('OrderComponents'),
      types: z.record(
        z.array(z.object({ name: z.string(), type: z.string() }).strict())
      ),
      message: marketOrderComponentsSchema
    })
    .strict();
  const typed = parseMarketValue(schema, input);
  assertMarketProtocol(typed.domain.verifyingContract);
  const keys = Object.keys(typed.types).sort((a, b) => a.localeCompare(b));
  if (
    JSON.stringify(keys) !==
      JSON.stringify(
        Object.keys(SEAPORT_ORDER_TYPES).sort((a, b) => a.localeCompare(b))
      ) ||
    keys.some(
      (key) =>
        JSON.stringify(typed.types[key]) !==
        JSON.stringify(
          SEAPORT_ORDER_TYPES[key as keyof typeof SEAPORT_ORDER_TYPES]
        )
    )
  )
    throw new MarketValidationError(
      'ORDER_MISMATCH',
      'The typed-data fields differ from canonical Seaport OrderComponents.'
    );
  return {
    kind: 'SIGN_ORDER',
    chainId: 1,
    from: intent.wallet,
    order: validateMarketOrder(intent, typed.message)
  };
}

export function assertMarketEoaSignature(
  order: ValidatedMarketOrder,
  signature: string
): void {
  try {
    parseMarketValue(marketBytesSchema, signature);
    if (
      !sameMarketAddress(
        verifyTypedData(
          order.typedData.domain,
          order.typedData.types,
          order.components,
          signature
        ),
        order.components.offerer
      )
    )
      throw new Error('maker');
  } catch {
    throw new MarketValidationError(
      'INVALID_SIGNATURE',
      'The signature does not authorize this exact order.'
    );
  }
}

export function buildMarketFulfillment(
  intent: MarketTradeIntent,
  order: ValidatedMarketOrder,
  signature: string,
  extraData = '0x',
  fulfillerConduitKey = MARKET_OPENSEA_CONDUIT_KEY,
  criteriaResolvers: unknown = []
): MarketTransaction {
  const checked = validateMarketOrder(
    intent,
    order.components,
    order.protocolAddress
  );
  if (!['BUY', 'ACCEPT'].includes(intent.kind) || !intent.order)
    throw new MarketValidationError(
      'INVALID_INTENT',
      'Fulfillment requires one exact existing order.'
    );
  parseMarketValue(marketBytesSchema, signature);
  parseMarketValue(marketBytesSchema, extraData);
  marketSpender(fulfillerConduitKey);
  const c = checked.components;
  const criteria = validateMarketCriteria(intent, c, criteriaResolvers);
  if (c.orderType >= 2 && extraData === '0x')
    throw new MarketValidationError(
      'UNSUPPORTED_ZONE',
      'Restricted orders require current zone authorization.'
    );
  if (c.orderType < 2 && extraData !== '0x')
    throw new MarketValidationError(
      'UNSUPPORTED_ZONE',
      'Open orders cannot include unreviewed zone data.'
    );
  const original =
    intent.kind === 'BUY'
      ? c.offer[0].startAmount
      : c.consideration[0].startAmount;
  let numerator = BigInt(intent.quantity),
    denominator = BigInt(original);
  const gcd = (a: bigint, b: bigint): bigint => {
    while (b !== BigInt(0)) {
      const r = a % b;
      a = b;
      b = r;
    }
    return a;
  };
  const divisor = gcd(numerator, denominator);
  numerator /= divisor;
  denominator /= divisor;
  if (denominator > BigInt('0xffffffffffffffffffffffffffffff'))
    throw new MarketValidationError(
      'UNSUPPORTED_ACTION',
      'The exact fill fraction exceeds the protocol limit.'
    );
  const { counter: _counter, ...parameters } = c;
  const data = MARKET_SEAPORT_INTERFACE.encodeFunctionData(
    'fulfillAdvancedOrder',
    [
      {
        parameters: {
          ...parameters,
          totalOriginalConsiderationItems: c.consideration.length
        },
        numerator: numerator.toString(),
        denominator: denominator.toString(),
        signature,
        extraData
      },
      criteria,
      fulfillerConduitKey,
      intent.recipient
    ]
  );
  return {
    kind: 'TRANSACTION',
    chainId: 1,
    from: intent.wallet,
    to: MARKET_SEAPORT,
    value:
      intent.kind === 'BUY' &&
      sameMarketAddress(intent.currency, MARKET_ZERO_ADDRESS)
        ? checked.totalWei
        : '0',
    data,
    purpose: 'FULFILL'
  };
}

export function prepareMarketCancel(
  wallet: string,
  identity: MarketOrderIdentity,
  input: unknown
): MarketTransaction {
  assertMarketProtocol(identity.protocolAddress);
  const c = parseMarketValue(marketOrderComponentsSchema, input);
  if (!sameMarketAddress(c.offerer, wallet))
    throw new MarketValidationError(
      'ORDER_MISMATCH',
      'Only the maker can cancel this order.'
    );
  // Hash validation without granting the order any transfer permissions.
  if (
    TypedDataEncoder.hashStruct(
      'OrderComponents',
      SEAPORT_ORDER_TYPES,
      c
    ).toLowerCase() !== identity.orderHash.toLowerCase()
  )
    throw new MarketValidationError(
      'ORDER_MISMATCH',
      'The cancellation target changed.'
    );
  return {
    kind: 'TRANSACTION',
    chainId: 1,
    from: wallet,
    to: MARKET_SEAPORT,
    value: '0',
    data: MARKET_SEAPORT_INTERFACE.encodeFunctionData('cancel', [[c]]),
    purpose: 'CANCEL'
  };
}
