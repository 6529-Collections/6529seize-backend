import { z } from 'zod';
import {
  marketAddressSchema,
  marketUintSchema
} from '@/marketplace/seaport.schema';
import { MarketPrepareRequest } from '@/marketplace/market-preparation';

export const OFFER_ANALYSIS_POLICY = 'conservative_opening_v1';
export const OFFER_ANALYSIS_MAX_ASSETS = 1000;
export const OFFER_ANALYSIS_FRESH_MILLIS = 3600000;
export const OFFER_ANALYSIS_TTL_MILLIS = 60000;
export const offerAnalysisSchema = z
  .object({
    profile_id: z.string().min(1).max(100),
    wallet: marketAddressSchema,
    recipient: marketAddressSchema,
    acknowledge_external_recipient: z.boolean(),
    expires_at: z.number().int().positive().safe(),
    assets: z
      .array(
        z
          .object({
            asset_key: z.string().min(1).max(150),
            quantity: marketUintSchema.refine(
              (value) => BigInt(value) > BigInt(0)
            ),
            manual_unit_amount_wei: marketUintSchema
              .refine((value) => BigInt(value) > BigInt(0))
              .optional()
          })
          .strict()
      )
      .min(1)
      .max(OFFER_ANALYSIS_MAX_ASSETS),
    method: z
      .object({
        kind: z.enum([
          'manual',
          'match_bid',
          'improve_bid',
          'discount_ask',
          'goal'
        ]),
        basis_points: z.number().int().min(0).max(100000).optional()
      })
      .strict(),
    max_total_weth_wei: marketUintSchema
      .refine((value) => BigInt(value) > BigInt(0))
      .optional()
  })
  .strict()
  .superRefine((request, context) => {
    const percent = ['improve_bid', 'discount_ask'].includes(
      request.method.kind
    );
    if (percent !== (request.method.basis_points !== undefined))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['method', 'basis_points'],
        message:
          'A percentage is required only for a percentage pricing method.'
      });
    if (
      request.method.kind === 'discount_ask' &&
      (request.method.basis_points ?? 10000) >= 10000
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['method', 'basis_points'],
        message: 'The discount must be below 100 percent.'
      });
    if (request.method.kind === 'goal' && !request.max_total_weth_wei)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['max_total_weth_wei'],
        message: 'Goal allocation requires an explicit budget.'
      });
    if (
      request.method.kind === 'manual' &&
      request.assets.some((asset) => !asset.manual_unit_amount_wei)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assets'],
        message: 'Manual pricing requires a unit price for every NFT.'
      });
    const keys = request.assets.map((asset) => asset.asset_key.toLowerCase());
    if (new Set(keys).size !== keys.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assets'],
        message: 'Combine quantities for the same NFT before analysis.'
      });
  });
export type OfferAnalysisRequest = z.infer<typeof offerAnalysisSchema>;
export type OfferAnalysisReason =
  | 'MANUAL_PRICE'
  | 'MATCH_BID'
  | 'IMPROVE_BID'
  | 'DISCOUNT_ASK'
  | 'GOAL_PATIENT_OPENING'
  | 'NO_APPLICABLE_BID'
  | 'NO_APPLICABLE_ASK'
  | 'STALE_MARKET_DATA'
  | 'UNSUPPORTED_ASSET'
  | 'INSUFFICIENT_GOAL_EVIDENCE'
  | 'AMOUNT_OVERFLOW'
  | 'BUDGET_EXCEEDED'
  | 'INSUFFICIENT_WETH'
  | 'PIN_CONFLICT'
  | 'NO_MARKET_DATA'
  | 'ETH_ASK_WETH_COMPARISON'
  | 'OBSERVED_REFERENCE_ONLY';
export interface OfferPriceReference {
  kind: 'bid' | 'ask';
  order_hash: string;
  protocol_address: string;
  maker: string;
  currency: string;
  quantity: string;
  unit_amount_wei: string;
  total_amount_wei: string;
  observed_at: number;
  expires_at: number;
  source: 'OpenSea';
  eligibility: 'EXACT_TOKEN_TERMS';
  verification: 'OBSERVED_NOT_CHAIN_VERIFIED';
  funding: 'UNKNOWN';
}
export interface OfferAssetSignals {
  asset_key: string;
  standard: 'ERC721' | 'ERC1155';
  bid?: OfferPriceReference;
  ask?: OfferPriceReference;
  distinct_ask_makers: number;
  distinct_bid_makers: number;
  coverage_complete: boolean;
  reason_codes: OfferAnalysisReason[];
}
export interface OfferAnalysisRow {
  asset_key: string;
  quantity: string;
  pinned: boolean;
  status: 'PRICED' | 'UNAVAILABLE' | 'EXCLUDED_BUDGET' | 'PIN_CONFLICT';
  unit_amount_wei?: string;
  total_amount_wei?: string;
  selected: boolean;
  reason_codes: OfferAnalysisReason[];
  references: OfferPriceReference[];
  prepare_request?: MarketPrepareRequest;
}
