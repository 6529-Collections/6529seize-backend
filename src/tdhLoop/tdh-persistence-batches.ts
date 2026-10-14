export const TDH_SAVE_BATCH_SIZE = 500;

interface TdhUpsertRepository<Entity> {
  metadata: {
    primaryColumns: readonly { propertyPath: string }[];
  };
  upsert(rows: Entity[], conflictPaths: string[]): Promise<unknown>;
}

/** Use the caller's transaction repository; a failed batch aborts the write. */
export async function upsertTdhInBatches<Entity>(
  repository: TdhUpsertRepository<Entity>,
  rows: readonly Entity[]
): Promise<void> {
  const conflictPaths = repository.metadata.primaryColumns.map(
    (column) => column.propertyPath
  );
  // Let MySQL match composite keys, including bigint IDs loaded as strings.
  // Bounded sequential writes avoid ORM entity matching and overlapping work
  // on the caller's shared transaction connection.
  for (let offset = 0; offset < rows.length; offset += TDH_SAVE_BATCH_SIZE) {
    await repository.upsert(
      rows.slice(offset, offset + TDH_SAVE_BATCH_SIZE),
      conflictPaths
    );
  }
}
