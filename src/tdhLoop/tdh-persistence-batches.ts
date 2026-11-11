import { ObjectLiteral, Repository } from 'typeorm';
import { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';

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

/**
 * Sets one column of existing rows, matched by primary key, to each row's own
 * value, and nothing else. Values are prepared as the upsert prepares them,
 * so the column stores what a full-row write would.
 */
export async function refreshTdhColumnInBatches<Entity extends ObjectLiteral>(
  repository: Repository<Entity>,
  rows: readonly Entity[],
  propertyName: string
): Promise<void> {
  const { metadata, manager } = repository;
  const column = metadata.findColumnWithPropertyName(propertyName);
  const keys = metadata.primaryColumns;
  if (!column || keys.includes(column)) {
    throw new Error(`${metadata.tableName}: cannot refresh ${propertyName}`);
  }
  const driver = manager.connection.driver;
  const name = (databaseName: string) => driver.escape(databaseName);
  const value = (row: Entity, of: ColumnMetadata) =>
    driver.preparePersistentValue(of.getEntityValue(row), of);
  const keyMatch = keys
    .map((key) => `${name(key.databaseName)} = ?`)
    .join(' and ');
  const keyTuple = `(${keys.map((key) => name(key.databaseName)).join(', ')})`;
  const placeholders = `(${keys.map(() => '?').join(', ')})`;
  for (let offset = 0; offset < rows.length; offset += TDH_SAVE_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + TDH_SAVE_BATCH_SIZE);
    const params: unknown[] = [];
    for (const row of batch) {
      params.push(...keys.map((key) => value(row, key)), value(row, column));
    }
    for (const row of batch) {
      params.push(...keys.map((key) => value(row, key)));
    }
    await repository.query(
      `update ${name(metadata.tableName)} set ${name(column.databaseName)} = case ${batch
        .map(() => `when ${keyMatch} then ?`)
        .join(' ')} end where ${keyTuple} in (${batch
        .map(() => placeholders)
        .join(', ')})`,
      params
    );
  }
}
