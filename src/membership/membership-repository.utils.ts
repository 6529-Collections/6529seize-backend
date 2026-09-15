import { RequestContext } from '@/request.context';
import { markMembershipTransactionFailed } from './membership-primary';

export const MEMBERSHIP_DB_NOW =
  'CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS UNSIGNED)';

export async function timeMembershipOperation<T>(
  name: string,
  ctx: RequestContext,
  operation: () => Promise<T>
): Promise<T> {
  ctx.timer?.start(name);
  try {
    return await operation();
  } catch (error) {
    markMembershipTransactionFailed(ctx, error);
    throw error;
  } finally {
    ctx.timer?.stop(name);
  }
}

export function requireMembershipLabel(
  value: string,
  name: string,
  limit = 100
): void {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > limit ||
    !/^[A-Za-z0-9_.:/-]+$/.test(value)
  ) {
    throw new Error(`Invalid membership ${name}`);
  }
}

export function compareMembershipIds(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}
