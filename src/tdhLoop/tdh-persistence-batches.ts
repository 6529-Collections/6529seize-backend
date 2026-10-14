import { ObjectLiteral, Repository } from 'typeorm';

export const TDH_SAVE_BATCH_SIZE = 500;

/** Use the caller's transaction repository; a failed batch aborts the write. */
export async function upsertTdhInBatches<Entity extends ObjectLiteral>(
  repository: Repository<Entity>,
  rows: readonly Entity[]
): Promise<void> {
  const { columns, primaryColumns } = repository.metadata;
  const conflictColumns = primaryColumns.map((column) => column.databaseName);
  // Let MySQL match composite keys, including bigint IDs loaded as strings.
  // Bounded sequential writes avoid ORM entity matching and overlapping work
  // on the caller's shared transaction connection.
  for (let offset = 0; offset < rows.length; offset += TDH_SAVE_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + TDH_SAVE_BATCH_SIZE);
    const overwriteColumns = columns.filter(
      (column) =>
        primaryColumns.includes(column) ||
        batch.some((row) => column.getEntityValue(row) !== undefined)
    );
    await repository
      .createQueryBuilder()
      .insert()
      .values(batch)
      .orUpdate(
        overwriteColumns.map((column) => column.databaseName),
        conflictColumns
      )
      // TypeORM hydrates upsert return rows by position, which can reassign
      // keys when MySQL returns defaults in a different order. These same
      // objects are reused for history; keep their keys and scores intact.
      .updateEntity(false)
      .execute();
  }
}
