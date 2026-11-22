/** InnoDB deadlock victims, including sanitized private-family errors. */
export function isDeadlockError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, errno } = error as { code?: unknown; errno?: unknown };
  return code === 'ER_LOCK_DEADLOCK' || errno === 1213;
}
