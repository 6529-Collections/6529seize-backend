/** Missing or invalid contributions must never masquerade as an unread count of zero. */
export function sumBadgeContributions(
  contributions: PromiseSettledResult<unknown>[]
): number {
  return contributions.reduce((sum, contribution) => {
    if (contribution.status !== 'fulfilled') {
      throw new Error('Unable to refresh all profile badge counts');
    }
    const value = contribution.value;
    const count =
      typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      throw new Error('Invalid profile badge count');
    }
    const total = sum + count;
    if (!Number.isSafeInteger(total))
      throw new Error('Device badge count overflow');
    return total;
  }, 0);
}
