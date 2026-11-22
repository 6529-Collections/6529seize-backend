/**
 * The database is not at the freeze day the export was asked for: its TDH
 * block is another, or the identities sync hasn't caught up with it.
 */
export class IdentityExportNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'IdentityExportNotReadyError';
  }
}
