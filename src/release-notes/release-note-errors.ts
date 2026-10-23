export class NonRetryableReleaseNoteError extends Error {
  public readonly cause: unknown;

  public constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'NonRetryableReleaseNoteError';
    this.cause = cause;
    Object.setPrototypeOf(this, NonRetryableReleaseNoteError.prototype);
  }
}

export class UntrustedReleaseNoteMetadataError extends NonRetryableReleaseNoteError {
  public constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'UntrustedReleaseNoteMetadataError';
    Object.setPrototypeOf(this, UntrustedReleaseNoteMetadataError.prototype);
  }
}

/** An empty stream has no publication range yet; later deploys may bootstrap. */
export class NoReleaseNoteBaselineError extends NonRetryableReleaseNoteError {
  public constructor(message: string) {
    super(message);
    this.name = 'NoReleaseNoteBaselineError';
    Object.setPrototypeOf(this, NoReleaseNoteBaselineError.prototype);
  }
}

export function isNonRetryableReleaseNoteError(
  error: unknown
): error is NonRetryableReleaseNoteError {
  return error instanceof NonRetryableReleaseNoteError;
}

/** Expected waiting states must not consume publication failure attempts. */
export class DeferredReleaseNoteError extends Error {
  public constructor(
    public readonly code:
      | 'PUBLICATION_BLOCKED'
      | 'WORKFLOW_NOT_SETTLED'
      | 'PART_BUDGET_EXHAUSTED',
    message: string
  ) {
    super(message);
    this.name = 'DeferredReleaseNoteError';
    Object.setPrototypeOf(this, DeferredReleaseNoteError.prototype);
  }
}

export class ReleaseNoteDependencyError extends Error {
  public constructor(
    message: string,
    public readonly retryAfterMs = 0
  ) {
    super(message);
    this.name = 'ReleaseNoteDependencyError';
    Object.setPrototypeOf(this, ReleaseNoteDependencyError.prototype);
  }
}
