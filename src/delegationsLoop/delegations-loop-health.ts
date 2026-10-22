import { NFTDELEGATION_BLOCKS_TABLE } from '@/constants';
import { readLoopHealthRows } from '@/loop-health-read';
import { LoopHealthObservation, reportLoopHealth } from '@/loop-health';

export class DelegationsLoopHealth {
  private progressAt: number | undefined;
  private constructor(
    private readonly checkpointAt: number | undefined,
    private readonly maintenance: boolean
  ) {}

  static async start(maintenance: boolean): Promise<DelegationsLoopHealth> {
    let checkpointAt: number | undefined;
    try {
      const [checkpoint] = await readLoopHealthRows<{
        timestamp: number | string;
      }>(
        `select timestamp from ${NFTDELEGATION_BLOCKS_TABLE} order by block desc limit 1`
      );
      const value = Number(checkpoint?.timestamp);
      if (Number.isSafeInteger(value) && value > 0) checkpointAt = value;
    } catch {
      // An unavailable monitoring read cannot prevent indexing or maintenance.
    }
    const health = new DelegationsLoopHealth(checkpointAt, maintenance);
    health.emit('indexing', true);
    if (maintenance) health.emit('recalculation', true);
    return health;
  }

  committedStage(): void {
    this.progressAt = Math.floor(Date.now() / 1000);
    this.emit('indexing', true);
    if (this.maintenance) this.emit('recalculation', true);
  }

  completed(blockTimestamp?: number): void {
    this.progressAt = Math.floor(Date.now() / 1000);
    if (this.maintenance) {
      this.emit('recalculation', false);
      // Completing maintenance does not establish scheduled indexing recovery.
      this.emit('indexing', true);
    } else this.emit('indexing', false, blockTimestamp);
  }

  failed(): void {
    // Synchronous maintenance is not replayed by ordinary scheduled scans.
    if (this.maintenance)
      this.emit('recalculation', true, undefined, 'unavailable');
  }

  private emit(
    operation: LoopHealthObservation['operation'],
    pending: boolean,
    watermarkAt?: number,
    recovery?: LoopHealthObservation['recovery']
  ): void {
    reportLoopHealth({
      operation,
      pending,
      progressAt: this.progressAt,
      ...(pending && this.checkpointAt
        ? { oldestPendingAt: this.checkpointAt }
        : {}),
      ...(watermarkAt ? { watermarkAt } : {}),
      recovery:
        recovery ?? (this.checkpointAt || !pending ? 'automatic' : 'unknown')
    });
  }
}
