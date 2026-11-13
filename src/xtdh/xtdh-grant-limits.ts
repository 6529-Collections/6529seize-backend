import { Logger } from '@/logging';

const logger = Logger.get('XTDH_GRANT_LIMITS');

/**
 * Bounds on one xTDH grant request, checked before its token list is
 * expanded:
 * - `XTDH_GRANT_MAX_TOKENS`, default 10,000: tokens one grant may target,
 *   ranges counted by width. The web client's token picker already stops a
 *   selection at 10,000 tokens; a whole collection is granted with an empty
 *   list instead.
 * - `XTDH_GRANT_MAX_RANGE_WIDTH`, default 10,000: tokens in one "a-b" range.
 *   Range ends must also be safe integers, since ranges are expanded
 *   numerically; single token ids of any size stay as given.
 * - `XTDH_MAX_PENDING_GRANTS`, default 50: grants one identity may have
 *   waiting for review. Grants leave PENDING within minutes unless their
 *   collection is still being indexed.
 */
export const XTDH_GRANT_LIMIT_DEFAULTS = {
  maxTokens: 10_000,
  maxRangeWidth: 10_000,
  maxPendingGrants: 50
} as const;

export type XTdhGrantLimits = {
  readonly maxTokens: number;
  readonly maxRangeWidth: number;
  readonly maxPendingGrants: number;
};

function positiveLimit(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (Number.isSafeInteger(value) && value > 0) return value;
  logger.warn(`Invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`);
  return fallback;
}

export function xTdhGrantLimits(
  env: NodeJS.ProcessEnv = process.env
): XTdhGrantLimits {
  return {
    maxTokens: positiveLimit(
      env,
      'XTDH_GRANT_MAX_TOKENS',
      XTDH_GRANT_LIMIT_DEFAULTS.maxTokens
    ),
    maxRangeWidth: positiveLimit(
      env,
      'XTDH_GRANT_MAX_RANGE_WIDTH',
      XTDH_GRANT_LIMIT_DEFAULTS.maxRangeWidth
    ),
    maxPendingGrants: positiveLimit(
      env,
      'XTDH_MAX_PENDING_GRANTS',
      XTDH_GRANT_LIMIT_DEFAULTS.maxPendingGrants
    )
  };
}

const TOKEN_OR_RANGE = /^(\d+)(?:-(\d+))?$/;

/**
 * Why `targetTokens` exceeds the limits, or null when it is within them.
 * Works on the strings alone, so nothing is expanded to find out. Items that
 * are not a token id or range are left to the format validation.
 */
export function xTdhGrantTokensProblem(
  targetTokens: readonly string[],
  {
    maxTokens,
    maxRangeWidth
  }: Pick<XTdhGrantLimits, 'maxTokens' | 'maxRangeWidth'>
): string | null {
  if (targetTokens.length > maxTokens) {
    return `A grant can target at most ${maxTokens} tokens; grant the whole collection to cover more.`;
  }
  let total = BigInt(0);
  for (const item of targetTokens) {
    const match = TOKEN_OR_RANGE.exec(item);
    if (!match) continue;
    if (match[2] === undefined) {
      total += BigInt(1);
    } else {
      const start = BigInt(match[1]);
      const end = BigInt(match[2]);
      const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
      if (start > maxSafe || end > maxSafe) {
        return `Range "${item}" must use token ids up to ${Number.MAX_SAFE_INTEGER}; list larger ids individually.`;
      }
      const width = end - start + BigInt(1);
      if (width > BigInt(maxRangeWidth)) {
        return `Range "${item}" covers ${width.toString()} tokens; a range can cover at most ${maxRangeWidth}.`;
      }
      if (width > BigInt(0)) total += width;
    }
    if (total > BigInt(maxTokens)) {
      return `A grant can target at most ${maxTokens} tokens; grant the whole collection to cover more.`;
    }
  }
  return null;
}
