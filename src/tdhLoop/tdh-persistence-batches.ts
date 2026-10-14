export const TDH_SAVE_BATCH_SIZE = 500;

interface TdhSaveRepository<Entity> {
  save(rows: Entity[]): Promise<unknown>;
}

/** Use the caller's transaction repository; a failed batch aborts the save. */
export async function saveTdhInBatches<Entity>(
  repository: TdhSaveRepository<Entity>,
  rows: readonly Entity[]
): Promise<void> {
  // TypeORM matches loaded rows against every save subject. Bounding each
  // call avoids quadratic matching across the entire global ranking dataset.
  for (let offset = 0; offset < rows.length; offset += TDH_SAVE_BATCH_SIZE) {
    await repository.save(rows.slice(offset, offset + TDH_SAVE_BATCH_SIZE));
  }
}
