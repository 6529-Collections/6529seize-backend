import * as Joi from 'joi';
import { MEMES_CONTRACT } from '@/constants';
import { numbers } from '@/numbers';
import { equalIgnoreCase } from '@/strings';

/**
 * Upper bound for `card_count`. The web app asks for the cards left in the
 * current season (about 40 on the first day of a season).
 */
export const MAX_UPCOMING_CARD_COUNT = 60;
const DEFAULT_UPCOMING_CARD_COUNT = 3;

/** Absent or unparsable values keep the default of 3; others are clamped. */
export function resolveUpcomingCardCount(value: unknown): number {
  const parsed = numbers.parseIntOrNull(value);
  if (parsed === null) {
    return DEFAULT_UPCOMING_CARD_COUNT;
  }
  return Math.min(Math.max(parsed, 1), MAX_UPCOMING_CARD_COUNT);
}

/** Subscriptions exist only for The Memes; the canonical address is kept. */
const memesContractSchema = Joi.string()
  .required()
  .custom((value: string, helpers) =>
    equalIgnoreCase(value, MEMES_CONTRACT)
      ? MEMES_CONTRACT
      : helpers.error('any.only', { valids: [MEMES_CONTRACT] })
  );

const tokenIdSchema = Joi.number().integer().min(1).required();

export interface SubscriptionToggleRequest {
  contract: string;
  token_id: number;
  subscribed: boolean;
}

export interface SubscriptionCountRequest {
  contract: string;
  token_id: number;
  count: number;
}

export const subscriptionToggleRequestSchema =
  Joi.object<SubscriptionToggleRequest>({
    contract: memesContractSchema,
    token_id: tokenIdSchema,
    subscribed: Joi.boolean().required()
  });

/**
 * The web app offers counts from 1 to the eligibility count; unsubscribing
 * goes through the toggle request, so a count is always at least 1.
 */
export const subscriptionCountRequestSchema =
  Joi.object<SubscriptionCountRequest>({
    contract: memesContractSchema,
    token_id: tokenIdSchema,
    count: Joi.number().integer().min(1).required()
  });
