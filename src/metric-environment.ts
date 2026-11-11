/**
 * Metric environment from the deployment's own settings. Only explicit
 * production, staging and development names map to those buckets; anything
 * else is reported as `unknown` rather than counted as production.
 */
export function metricEnvironment(
  configured: string | undefined = process.env.SENTRY_ENVIRONMENT ??
    process.env.OPS_ENVIRONMENT ??
    process.env.NODE_ENV
): 'prod' | 'staging' | 'dev' | 'unknown' {
  const value = (configured ?? '').toLowerCase();
  if (value.includes('staging')) return 'staging';
  if (/(^|[^a-z])(prod|production)([^a-z]|$)/.test(value)) return 'prod';
  if (/(^|[^a-z])(dev|development|local|test)([^a-z]|$)/.test(value))
    return 'dev';
  return 'unknown';
}
