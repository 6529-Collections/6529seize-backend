import * as Joi from 'joi';
import { ValidationError } from 'joi';
import { WALLET_REGEX } from '@/constants';
import { Time } from '../../../../time';
import { ApiXTdhCreateGrant } from '../../generated/models/ApiXTdhCreateGrant';
import { ApiXTdhGrantTargetChain } from '../../generated/models/ApiXTdhGrantTargetChain';

const targetTokensSchema = Joi.array()
  .items(
    Joi.string()
      .pattern(/^\d+(?:-\d+)?$/)
      .message(
        'Each item must be a non-negative integer or a range "a-b" (no spaces).'
      )
  )
  .min(0)
  .custom((arr: any, helpers) => {
    const intervals = arr.map((tok: string) => {
      const parts = tok.split('-');
      const start = Number.parseInt(parts[0], 10);
      const end = parts.length === 2 ? Number.parseInt(parts[1], 10) : start;

      if (parts.length === 2 && start >= end) {
        return helpers.error('any.invalid', {
          message: `Range "${tok}" must be in smaller-larger form (e.g., "3-10").`
        });
      }
      return { start, end, raw: tok };
    });

    if (intervals.some((x: any) => x?.isJoi)) {
      return intervals.find((x: ValidationError) => x?.isJoi);
    }

    intervals.sort(
      (a: { start: number; end: number }, b: { start: number; end: number }) =>
        a.start - b.start || a.end - b.end
    );

    for (let i = 1; i < intervals.length; i++) {
      const prev = intervals[i - 1];
      const cur = intervals[i];
      if (cur.start <= prev.end) {
        return helpers.error('any.invalid', {
          message: `Overlapping tokens: "${prev.raw}" and "${cur.raw}".`
        });
      }
    }

    return arr;
  }, 'non-overlapping integer/range validation');

export const ApiXTdhCreateGrantSchema: Joi.ObjectSchema<ApiXTdhCreateGrant> =
  Joi.object<ApiXTdhCreateGrant>({
    target_chain: Joi.string()
      .valid(...Object.values(ApiXTdhGrantTargetChain))
      .required(),
    target_contract: Joi.string().required().regex(WALLET_REGEX).lowercase(),
    target_tokens: targetTokensSchema,
    valid_to: Joi.number()
      .integer()
      .greater(Time.now().toMillis())
      .optional()
      .allow(null)
      .default(null),
    rate: Joi.number().positive().required(),
    is_irrevocable: Joi.boolean().required()
  });
