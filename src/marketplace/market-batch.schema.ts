import { z } from 'zod';
import {
  marketAddressSchema,
  marketHashSchema,
  marketUintSchema
} from '@/marketplace/seaport.schema';
import {
  MARKET_SEAPORT,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';

/** Bounds provider fan-out and mapping/receipt work, never edition count or spend. */
export const MARKET_BATCH_LIMITS = Object.freeze({
  max_orders: 128,
  max_allocations: 256,
  max_calldata_bytes: 1024 * 1024
});

const address = marketAddressSchema
  .transform((value) => value.toLowerCase())
  .refine((value) => value !== MARKET_ZERO_ADDRESS, 'A recipient is required.');
const positiveUint = marketUintSchema.refine(
  (value) => /^[1-9]\d*$/.test(value),
  'The amount must be positive.'
);
const allocation = z
  .object({
    recipient: address,
    quantity: positiveUint,
    acknowledge_external_recipient: z.boolean()
  })
  .strict();
const line = z
  .object({
    asset_key: z.string().min(1).max(150),
    order: z
      .object({
        protocol_address: marketAddressSchema
          .transform((value) => value.toLowerCase())
          .refine((value) => value === MARKET_SEAPORT),
        order_hash: marketHashSchema.transform((value) => value.toLowerCase())
      })
      .strict(),
    quantity: positiveUint,
    amount_wei: positiveUint,
    allocations: z
      .array(allocation)
      .min(1)
      .max(MARKET_BATCH_LIMITS.max_allocations)
  })
  .strict();

/** Deliberately separate from the legacy single-asset request. */
export const marketBatchPrepareSchema = z
  .object({
    kind: z.literal('BUY_BATCH'),
    profile_id: z.string().min(1).max(100),
    wallet: address,
    currency: z.literal(MARKET_ZERO_ADDRESS),
    execution_policy: z.literal('ALL_OR_REVERT'),
    amount_wei: positiveUint,
    items: z.array(line).min(1).max(MARKET_BATCH_LIMITS.max_orders)
  })
  .strict()
  .superRefine((request, context) => {
    const amounts = [
      request.amount_wei,
      ...request.items.flatMap((item) => [
        item.quantity,
        item.amount_wei,
        ...item.allocations.map((entry) => entry.quantity)
      ])
    ];
    if (!amounts.every((value) => marketUintSchema.safeParse(value).success))
      return;
    const orders = new Set<string>();
    let allocations = 0;
    let total = BigInt(0);
    request.items.forEach((item, index) => {
      const key = `${item.order.protocol_address}:${item.order.order_hash}`;
      if (orders.has(key))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'order'],
          message: 'Select each exact order only once.'
        });
      orders.add(key);
      const recipients = new Set(
        item.allocations.map((entry) => entry.recipient)
      );
      const quantity = item.allocations.reduce(
        (sum, entry) => sum + BigInt(entry.quantity),
        BigInt(0)
      );
      if (
        quantity !== BigInt(item.quantity) ||
        recipients.size !== item.allocations.length
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'allocations'],
          message:
            'Distinct recipient allocations must equal the selected quantity.'
        });
      allocations += item.allocations.length;
      total += BigInt(item.amount_wei);
    });
    if (allocations > MARKET_BATCH_LIMITS.max_allocations)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'Too many recipient allocations for one transaction.'
      });
    if (total !== BigInt(request.amount_wei))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount_wei'],
        message: 'The total must equal the exact selected order costs.'
      });
  });

export type MarketBatchPrepareRequest = z.infer<
  typeof marketBatchPrepareSchema
>;
