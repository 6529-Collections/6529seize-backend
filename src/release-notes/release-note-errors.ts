export class NonRetryableReleaseNoteError extends Error {
  public readonly cause: unknown;

  public constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'NonRetryableReleaseNoteError';
    this.cause = cause;
    Object.setPrototypeOf(this, NonRetryableReleaseNoteError.prototype);
  }
}

export function isNonRetryableReleaseNoteError(
  error: unknown
): error is NonRetryableReleaseNoteError {
  return error instanceof NonRetryableReleaseNoteError;
}
