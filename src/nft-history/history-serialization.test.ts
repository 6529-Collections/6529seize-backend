import { DataSource } from 'typeorm';
import { NFTHistoryEventEntity } from '@/entities/INFTHistoryEvent';

// Build ORM metadata and SQL only; never initialize a connection or a schema.
it.each([
  null,
  {
    event: 'Edit',
    changes: [{ key: 'nested', from: { count: 0 }, to: [false, 'value'] }]
  }
])(
  'binds raw inserts exactly like the MySQL JSON column transform: %j',
  async (description) => {
    const source = new DataSource({
      type: 'mysql',
      database: 'metadata_only',
      entities: [NFTHistoryEventEntity]
    });
    await (
      source as unknown as { buildMetadatas(): Promise<void> }
    ).buildMetadatas();
    const column = source
      .getMetadata(NFTHistoryEventEntity)
      .findColumnWithPropertyName('description')!;
    const ormParameter = source.driver.preparePersistentValue(
      description,
      column
    );
    const rawParameter =
      description === null ? null : JSON.stringify(description);
    const [sql, parameters] = source
      .getRepository(NFTHistoryEventEntity)
      .createQueryBuilder()
      .insert()
      .values({
        event_id: 'serialization-check',
        description: () => ':historyDescription'
      })
      .setParameter('historyDescription', rawParameter)
      .getQueryAndParameters();
    expect(sql).toContain('INSERT INTO');
    expect(sql).not.toContain('ON DUPLICATE');
    expect(rawParameter).toEqual(ormParameter);
    expect(parameters).toContain(ormParameter);
    if (description !== null)
      expect(JSON.parse(String(rawParameter))).toEqual(description);
  }
);
