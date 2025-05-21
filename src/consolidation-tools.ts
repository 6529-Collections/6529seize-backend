import { equalIgnoreCase } from './strings';
import { CONSOLIDATIONS_LIMIT } from './constants';

export class ConsolidationTools {
  public extractConsolidationWallets(
    consolidations: any[],
    wallet: string
  ): string[] {
    const uniqueWallets: string[] = [];
    const seenWallets = new Set();

    consolidations.forEach((consolidation) => {
      if (!seenWallets.has(consolidation.wallet1)) {
        seenWallets.add(consolidation.wallet1);
        const shouldAdd = this.shouldAddConsolidation(
          uniqueWallets,
          consolidations,
          consolidation.wallet1
        );
        if (shouldAdd) {
          uniqueWallets.push(consolidation.wallet1);
          if (uniqueWallets.length === CONSOLIDATIONS_LIMIT) return;
        }
      }
      if (!seenWallets.has(consolidation.wallet2)) {
        seenWallets.add(consolidation.wallet2);
        const shouldAdd = this.shouldAddConsolidation(
          uniqueWallets,
          consolidations,
          consolidation.wallet2
        );
        if (shouldAdd) {
          uniqueWallets.push(consolidation.wallet2);
          if (uniqueWallets.length === CONSOLIDATIONS_LIMIT) return;
        }
      }
    });

    if (uniqueWallets.some((w) => equalIgnoreCase(w, wallet))) {
      return uniqueWallets.sort();
    }

    return [wallet];
  }

  private shouldAddConsolidation(
    uniqueWallets: any[],
    consolidations: any[],
    wallet: string
  ): boolean {
    let hasConsolidationsWithAll = true;
    uniqueWallets.forEach((w) => {
      if (
        !consolidations.some(
          (c) =>
            (equalIgnoreCase(c.wallet1, w) &&
              equalIgnoreCase(c.wallet2, wallet)) ||
            (equalIgnoreCase(c.wallet2, w) &&
              equalIgnoreCase(c.wallet1, wallet))
        )
      ) {
        hasConsolidationsWithAll = false;
      }
    });
    return hasConsolidationsWithAll;
  }

  public buildConsolidationKey(wallets: string[]): string {
    const sortedWallets = wallets
      .map((it) => it.toLowerCase())
      .slice()
      .sort((a, b) => a.localeCompare(b))
      .filter((it) => it !== '');
    return sortedWallets.join('-');
  }
}

export const consolidationTools = new ConsolidationTools();
