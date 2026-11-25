import {
  PartitionedWrite,
  RebuildStep,
  WrittenTable
} from '@/rebuild/manifest.types';

const tableOf = (write: WrittenTable): string =>
  typeof write === 'string' ? write : write.table;

/** The tables a step writes, whole or in part. */
export function writtenTables(step: RebuildStep): string[] {
  return step.writes.map(tableOf);
}

/** The partitions a step declares on the tables it writes. */
export function partitionsOf(step: RebuildStep): PartitionedWrite[] {
  return step.writes.filter(
    (write): write is PartitionedWrite => typeof write !== 'string'
  );
}

/** One writer of a table: the step, and its partition when it has one. */
export interface TableWriter {
  readonly step: string;
  readonly partition: PartitionedWrite['partition'] | null;
}

/** Every writer of each table, in the steps' order. */
export function writersOf(
  steps: readonly RebuildStep[]
): Map<string, TableWriter[]> {
  const writers = new Map<string, TableWriter[]>();
  for (const step of steps) {
    for (const write of step.writes) {
      const table = tableOf(write);
      writers.set(table, [
        ...(writers.get(table) ?? []),
        {
          step: step.id,
          partition: typeof write === 'string' ? null : write.partition
        }
      ]);
    }
  }
  return writers;
}
