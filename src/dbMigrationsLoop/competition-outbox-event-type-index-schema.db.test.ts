import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { COMPETITION_OUTBOX_TABLE } from '@/constants';
import { env } from '@/env';
import {
  COMPETITION_OUTBOX_EVENT_TYPE_INDEX,
  CompetitionOutboxEntity
} from '@/entities/ICompetitionRuntime';
import { describeWithSeed } from '@/tests/_setup/seed';
import { applyCompetitionOutboxEventTypeIndexSchema } from './competition-outbox-event-type-index-schema';

const outbox = (id: string, competitionId: string, eventType: string) => ({
  id,
  competition_id: competitionId,
  wave_id: `wave-${competitionId}`,
  semantic_key: `key-${id}`,
  event: { event_type: eventType, competition_entry_id: `entry-${id}` },
  created_at: 1,
  next_attempt_at: 1
});

describeWithSeed(
  'Competition outbox event type index online DDL',
  [
    {
      table: COMPETITION_OUTBOX_TABLE,
      rows: [
        outbox('o1', 'c1', 'COMPETITION_ENTRY_UPDATED'),
        outbox('o2', 'c1', 'COMPETITION_VOTE_CHANGED'),
        outbox('o3', 'c1', 'COMPETITION_VOTE_CHANGED'),
        outbox('o4', 'c2', 'COMPETITION_ENTRY_UPDATED')
      ]
    }
  ],
  () => {
    it('indexes the generated event type online, once, and the event-type filter uses it', async () => {
      const source = new DataSource({
        type: 'mysql',
        host: env.getStringOrThrow('DB_HOST'),
        port: env.getIntOrThrow('DB_PORT'),
        username: env.getStringOrThrow('DB_USER'),
        password: env.getStringOrThrow('DB_PASS'),
        database: env.getStringOrThrow('DB_NAME'),
        entities: [CompetitionOutboxEntity],
        synchronize: false,
        // As the app's pools: MySQL matches the JSON filter to the indexed
        // generated column only for utf8mb4 connections (the column's
        // expression stores its path literal as utf8mb4).
        charset: 'utf8mb4'
      });
      await source.initialize();
      try {
        const [existing] = await source.query(
          `SELECT count(*) AS n FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
          [COMPETITION_OUTBOX_TABLE, COMPETITION_OUTBOX_EVENT_TYPE_INDEX]
        );
        if (Number(existing.n) > 0)
          await source.query(
            `ALTER TABLE \`${COMPETITION_OUTBOX_TABLE}\` DROP INDEX \`${COMPETITION_OUTBOX_EVENT_TYPE_INDEX}\``
          );

        await expect(
          applyCompetitionOutboxEventTypeIndexSchema(source)
        ).resolves.toBe(1);
        await expect(
          applyCompetitionOutboxEventTypeIndexSchema(source)
        ).resolves.toBe(0);

        // Entity sync leaves both the generated column and the index alone.
        const plan = await source.driver.createSchemaBuilder().log();
        expect(
          plan.upQueries.filter(
            (it) =>
              it.query.includes(COMPETITION_OUTBOX_TABLE) ||
              it.query.includes('event_type')
          )
        ).toEqual([]);

        // The generated column reads the event's type.
        const types = await source.query(
          `SELECT id, event_type FROM \`${COMPETITION_OUTBOX_TABLE}\` ORDER BY id`
        );
        expect(
          types.map((it: { event_type: string }) => it.event_type)
        ).toEqual([
          'COMPETITION_ENTRY_UPDATED',
          'COMPETITION_VOTE_CHANGED',
          'COMPETITION_VOTE_CHANGED',
          'COMPETITION_ENTRY_UPDATED'
        ]);

        // A realistic competition: many events of other types.
        await source.query(
          `INSERT INTO \`${COMPETITION_OUTBOX_TABLE}\`
             (id, competition_id, wave_id, semantic_key, event, created_at, next_attempt_at)
           WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400)
           SELECT concat('bulk-', i), 'c1', 'wave-c1', concat('bulk-key-', i),
                  json_object('event_type', 'COMPETITION_VOTE_CHANGED'), i, i
           FROM n`
        );
        await source.query(`ANALYZE TABLE \`${COMPETITION_OUTBOX_TABLE}\``);

        // Queries keep the JSON expression; MySQL matches it to the column
        // and reads one competition's events of one type from the index.
        const [row] = await source.query(
          `EXPLAIN FORMAT=TREE SELECT id FROM \`${COMPETITION_OUTBOX_TABLE}\`
           WHERE competition_id = 'c1'
             AND json_unquote(json_extract(event,'$.event_type')) = 'COMPETITION_ENTRY_UPDATED'`
        );
        expect(Object.values(row)[0]).toContain(
          COMPETITION_OUTBOX_EVENT_TYPE_INDEX
        );
        const matches = await source.query(
          `SELECT id FROM \`${COMPETITION_OUTBOX_TABLE}\`
           WHERE competition_id = 'c1'
             AND json_unquote(json_extract(event,'$.event_type')) = 'COMPETITION_ENTRY_UPDATED'`
        );
        expect(matches.map((it: { id: string }) => it.id)).toEqual(['o1']);
      } finally {
        await source.destroy();
      }
    }, 60_000);
  }
);
