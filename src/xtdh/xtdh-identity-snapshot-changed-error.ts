import type { RetriedConflict } from '@/db/transaction-failure-log';

/**
 * The identities changed while the xTDH universe was calculated. SQS retries
 * the universe, and the xTDH loop reports the conflict only on its last
 * attempt (xtdh-retry-reporting), so the transaction layer logs it as a
 * warning rather than an operational error.
 */
export class XTdhIdentitySnapshotChangedError
  extends Error
  implements RetriedConflict
{
  public receiveCount?: number;
  public readonly retriedConflict = true as const;

  public constructor() {
    super(
      'Identity consolidation changed during xTDH calculation; retry the universe'
    );
    this.name = 'XTdhIdentitySnapshotChangedError';
    Object.setPrototypeOf(this, XTdhIdentitySnapshotChangedError.prototype);
  }
}
