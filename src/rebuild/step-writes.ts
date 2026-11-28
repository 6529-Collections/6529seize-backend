import {
  ColumnsWrite,
  PartitionedWrite,
  RebuildStep,
  WrittenTable
} from '@/rebuild/manifest.types';

const tableOf = (write: WrittenTable): string =>
  typeof write === 'string' ? write : write.table;

const isPartition = (write: WrittenTable): write is PartitionedWrite =>
  typeof write !== 'string' && 'partition' in write;

const isColumns = (write: WrittenTable): write is ColumnsWrite =>
  typeof write !== 'string' && 'columns' in write;

/** The tables a step writes: whole, in part, or some of their columns. */
export function writtenTables(step: RebuildStep): string[] {
  return step.writes.map(tableOf);
}

/** The tables whose rows a step writes: not those it only owns columns of. */
export function rowWrittenTables(step: RebuildStep): string[] {
  return step.writes.filter((write) => !isColumns(write)).map(tableOf);
}

/** The partitions a step declares on the tables it writes. */
export function partitionsOf(step: RebuildStep): PartitionedWrite[] {
  return step.writes.filter(isPartition);
}

/** The columns a step owns in tables other steps write the rows of. */
export function columnWritesOf(step: RebuildStep): ColumnsWrite[] {
  return step.writes.filter(isColumns);
}

/**
 * One writer of a table: the step, and its partition or owned columns when
 * it has one. A writer with `columns` is a column owner; the others write
 * rows.
 */
export interface TableWriter {
  readonly step: string;
  readonly partition: PartitionedWrite['partition'] | null;
  readonly columns: readonly string[] | null;
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
          partition: isPartition(write) ? write.partition : null,
          columns: isColumns(write) ? write.columns : null
        }
      ]);
    }
  }
  return writers;
}
