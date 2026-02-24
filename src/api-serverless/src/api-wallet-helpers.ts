export function mergeDuplicateWallets<
  T extends { wallet: string; amount: number }
>(results: T[]): T[] {
  const mergedResults = new Map<string, { wallet: string; amount: number }>();
  for (const r of results) {
    const walletKey = r.wallet.toLowerCase();
    const existing = mergedResults.get(walletKey);
    if (existing) {
      existing.amount += r.amount;
    } else {
      mergedResults.set(walletKey, {
        wallet: r.wallet,
        amount: r.amount
      });
    }
  }
  return Array.from(mergedResults.values()) as T[];
}
