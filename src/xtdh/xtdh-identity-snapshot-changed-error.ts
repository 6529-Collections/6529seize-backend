export class XTdhIdentitySnapshotChangedError extends Error {
  public receiveCount?: number;

  public constructor() {
    super(
      'Identity consolidation changed during xTDH calculation; retry the universe'
    );
    this.name = 'XTdhIdentitySnapshotChangedError';
    Object.setPrototypeOf(this, XTdhIdentitySnapshotChangedError.prototype);
  }
}
