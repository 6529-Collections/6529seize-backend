import { reportLoopHealth } from '@/loop-health';
import { readLoopHealthRows } from '@/loop-health-read';
import { NEXTGEN_BLOCKS_TABLE } from '@/nextgen/nextgen_constants';

export class NextgenLoopHealth {
  private incomplete = false;
  private checkpointAt: number | undefined;
  private reconciled = false;

  async start(): Promise<void> {
    try {
      const [row] = await readLoopHealthRows<{ timestamp: number | string }>(
        `select timestamp from ${NEXTGEN_BLOCKS_TABLE} order by block desc limit 1`
      );
      const timestamp = Number(row?.timestamp);
      if (
        Number.isSafeInteger(timestamp) &&
        timestamp > 0 &&
        timestamp <= Date.now() / 1000
      )
        this.checkpointAt = timestamp;
    } catch {
      // Unknown checkpoints never prevent business processing.
    }
    reportLoopHealth({
      operation: 'indexing',
      pending: true,
      oldestPendingAt: this.checkpointAt,
      recovery: this.checkpointAt ? 'automatic' : 'unknown'
    });
  }

  beginAttempt(): void {
    this.incomplete = false;
    this.reconciled = false;
  }

  startReconciliation(): void {
    this.reconciled = true;
    reportLoopHealth({
      operation: 'recalculation',
      pending: true,
      recovery: 'automatic'
    });
  }

  /** An internally handled enrichment failure must survive the handler return. */
  notCompleted(): void {
    this.incomplete = true;
  }

  committed(
    startBlock: number,
    endBlock: number,
    target: number,
    timestamp: number
  ): void {
    reportLoopHealth({
      operation: 'indexing',
      pending: endBlock < target,
      ...(endBlock > startBlock
        ? { progressAt: Math.floor(Date.now() / 1000) }
        : {}),
      watermarkAt: timestamp,
      ...(endBlock < target ? { oldestPendingAt: timestamp } : {}),
      recovery: 'automatic'
    });
    if (this.reconciled)
      reportLoopHealth({
        operation: 'recalculation',
        pending: this.incomplete,
        ...(!this.incomplete
          ? { progressAt: Math.floor(Date.now() / 1000) }
          : {}),
        recovery: this.incomplete ? 'unknown' : 'automatic'
      });
  }
}
