/** Collector base path. CloudFront maps 6529.io/e* to /api/e* on the API. */
export const TELEMETRY_BASE_PATH = '/api/e';
/** Diagnostics bundles (6529.io/e/diag). */
export const TELEMETRY_DIAGNOSTICS_PATH = `${TELEMETRY_BASE_PATH}/diag`;
