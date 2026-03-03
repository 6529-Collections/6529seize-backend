import { numbers } from '../numbers';

export function sumBadgeContributions(
  contributions: PromiseSettledResult<unknown>[]
): number {
  return contributions.reduce((sum, contribution) => {
    if (contribution.status !== 'fulfilled') {
      return sum;
    }
    const parsed = numbers.parseIntOrNull(contribution.value);
    return sum + (parsed ?? 0);
  }, 0);
}
