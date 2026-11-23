/**
 * An error a transaction throws on purpose, for work whose caller retries it
 * and reports it itself once the retries run out: the xTDH universe's
 * identity snapshot conflict, which SQS retries and the xTDH loop reports on
 * its last attempt. The transaction layer logs it as a warning, so the
 * first tries don't count as operational errors.
 */
export interface RetriedConflict {
  readonly retriedConflict: true;
}

export function isRetriedConflict(error: unknown): error is RetriedConflict {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as Partial<RetriedConflict>).retriedConflict === true
  );
}

/** Logs a failed transaction before its rollback. */
export function logTransactionFailure(
  error: unknown,
  logger: {
    warn: (message: string) => void;
    error: (message: string) => void;
  }
): void {
  if (isRetriedConflict(error)) {
    logger.warn(
      `Database transaction rolled back for a retried conflict [${error}]`
    );
  } else {
    logger.error(`Database transaction failed [${error}]`);
  }
}
