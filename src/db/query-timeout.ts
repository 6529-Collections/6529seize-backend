/** MySQL stopped a statement at its MAX_EXECUTION_TIME budget (3024). */
export function isQueryTimeout(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (('code' in error && error.code === 'ER_QUERY_TIMEOUT') ||
      ('errno' in error && error.errno === 3024))
  );
}
