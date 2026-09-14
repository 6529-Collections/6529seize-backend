import { z } from 'zod';
import { MarketValidationError } from '@/marketplace/provider.types';

const UINT256_MAX = BigInt(
  '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
);
export const marketAddressSchema = z.string().regex(/^0x[\da-fA-F]{40}$/);
export const marketHashSchema = z.string().regex(/^0x[\da-fA-F]{64}$/);
export const marketBytesSchema = z
  .string()
  .regex(/^0x(?:[\da-fA-F]{2})*$/)
  .max(32770);
export const marketUintSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .max(78)
  .refine(
    (value) => /^(0|[1-9]\d*)$/.test(value) && BigInt(value) <= UINT256_MAX
  );
export const marketOfferItemSchema = z
  .object({
    itemType: z.number().int().min(0).max(5),
    token: marketAddressSchema,
    identifierOrCriteria: marketUintSchema,
    startAmount: marketUintSchema,
    endAmount: marketUintSchema
  })
  .strict();
export const marketConsiderationItemSchema = marketOfferItemSchema
  .extend({
    recipient: marketAddressSchema
  })
  .strict();
const orderFields = {
  offerer: marketAddressSchema,
  zone: marketAddressSchema,
  offer: z.array(marketOfferItemSchema).min(1).max(1),
  consideration: z.array(marketConsiderationItemSchema).min(1).max(16),
  orderType: z.number().int().min(0).max(3),
  startTime: marketUintSchema,
  endTime: marketUintSchema,
  zoneHash: marketHashSchema,
  salt: marketUintSchema,
  conduitKey: marketHashSchema
};
export const marketOrderComponentsSchema = z
  .object({
    ...orderFields,
    counter: marketUintSchema
  })
  .strict();
export const marketOrderParametersSchema = z
  .object({
    ...orderFields,
    totalOriginalConsiderationItems: z.number().int().min(1).max(16)
  })
  .strict();

export const SEAPORT_ORDER_TYPES = {
  OrderComponents: [
    { name: 'offerer', type: 'address' },
    { name: 'zone', type: 'address' },
    { name: 'offer', type: 'OfferItem[]' },
    { name: 'consideration', type: 'ConsiderationItem[]' },
    { name: 'orderType', type: 'uint8' },
    { name: 'startTime', type: 'uint256' },
    { name: 'endTime', type: 'uint256' },
    { name: 'zoneHash', type: 'bytes32' },
    { name: 'salt', type: 'uint256' },
    { name: 'conduitKey', type: 'bytes32' },
    { name: 'counter', type: 'uint256' }
  ],
  OfferItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' }
  ],
  ConsiderationItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
    { name: 'recipient', type: 'address' }
  ]
};

export const SEAPORT_OFFER_TUPLE =
  '(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)';
export const SEAPORT_CONSIDERATION_TUPLE =
  '(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)';
export const SEAPORT_PARAMETERS_TUPLE = `(address offerer,address zone,${SEAPORT_OFFER_TUPLE}[] offer,${SEAPORT_CONSIDERATION_TUPLE}[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems)`;
export const SEAPORT_COMPONENTS_TUPLE = `(address offerer,address zone,${SEAPORT_OFFER_TUPLE}[] offer,${SEAPORT_CONSIDERATION_TUPLE}[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)`;
export const SEAPORT_BASIC_TUPLE =
  '(address considerationToken,uint256 considerationIdentifier,uint256 considerationAmount,address payable offerer,address zone,address offerToken,uint256 offerIdentifier,uint256 offerAmount,uint8 basicOrderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 offererConduitKey,bytes32 fulfillerConduitKey,uint256 totalOriginalAdditionalRecipients,(uint256 amount,address payable recipient)[] additionalRecipients,bytes signature)';

export function parseMarketValue<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new MarketValidationError(
      'ORDER_MISMATCH',
      'The marketplace response did not match its verified schema.'
    );
  }
  return parsed.data;
}

/** Discovery/UI timestamps must fit JavaScript Date; raw Seaport cancellation remains uint256. */
export function parseMarketTimestampSeconds(input: unknown): string {
  const seconds = parseMarketValue(marketUintSchema, input);
  if (BigInt(seconds) > BigInt(8640000000000))
    throw new MarketValidationError(
      'ORDER_MISMATCH',
      'The marketplace timestamp is outside the supported range.'
    );
  return seconds;
}
