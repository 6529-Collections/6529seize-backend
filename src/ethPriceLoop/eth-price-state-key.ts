/** Scope operational Redis state to both the deployment and database. */
export function ethPriceStateKey(purpose: string): string {
  if (!process.env.DB_NAME || !process.env.DB_HOST)
    throw new Error('ETH price state requires database identity');
  const environment =
    process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'local';
  return `eth-price:coinbase-${purpose}:v1:${environment}:${process.env.DB_HOST}:${process.env.DB_NAME}`;
}
