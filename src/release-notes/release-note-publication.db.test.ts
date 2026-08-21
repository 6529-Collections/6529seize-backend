import {
  RELEASE_NOTE_PUBLICATIONS_TABLE,
  RELEASE_NOTE_STREAM_STATES_TABLE
} from '@/constants';
import { ReleaseNotePublicationStatus } from '@/entities/IReleaseNotePublication';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { ReleaseNotePublicationDb } from './release-note-publication.db';

const stream = {
  key: 'stream-key',
  repository: '6529-Collections/6529seize-frontend',
  workflowId: '7',
  branch: 'main',
  environment: 'prod'
};
const previousRun = {
  id: '32470000000',
  number: 1659,
  sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
};
const currentRun = {
  id: '32471443637',
  number: 1660,
  sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
};

describeWithSeed(
  'ReleaseNotePublicationDb',
  { table: RELEASE_NOTE_PUBLICATIONS_TABLE, rows: [] },
  () => {
    const repository = new ReleaseNotePublicationDb(() => sqlExecutor);

    it('freezes the baseline, records progress, and advances the cursor atomically', async () => {
      const prepared = await repository.preparePublication(
        {
          publicationId: 'publication-id',
          stream,
          currentRun,
          bootstrapPreviousRun: previousRun
        },
        {}
      );

      expect(prepared).toEqual(
        expect.objectContaining({
          publication_id: 'publication-id',
          previous_run_number: 1659,
          previous_sha: previousRun.sha,
          status: ReleaseNotePublicationStatus.Pending,
          next_part: 1
        })
      );

      await repository.recordPlan('publication-id', 11, {});
      await expect(
        repository.completePublication('publication-id', {})
      ).rejects.toThrow('has unfinished parts');
      await repository.recordPart(
        {
          publicationId: 'publication-id',
          partNumber: 6,
          totalParts: 11,
          dropId: 'part-six-drop'
        },
        {}
      );

      const publishing = await sqlExecutor.oneOrNull<{
        readonly status: string;
        readonly total_parts: number;
        readonly next_part: number;
        readonly last_drop_id: string;
      }>(
        `select status, total_parts, next_part, last_drop_id
         from ${RELEASE_NOTE_PUBLICATIONS_TABLE}
         where publication_id = :publicationId`,
        { publicationId: 'publication-id' }
      );
      expect(publishing).toEqual({
        status: ReleaseNotePublicationStatus.Publishing,
        total_parts: 11,
        next_part: 7,
        last_drop_id: 'part-six-drop'
      });

      await repository.completePublication('publication-id', {});

      const completed = await sqlExecutor.oneOrNull<{
        readonly status: string;
        readonly next_part: number;
      }>(
        `select status, next_part
         from ${RELEASE_NOTE_PUBLICATIONS_TABLE}
         where publication_id = :publicationId`,
        { publicationId: 'publication-id' }
      );
      const cursor = await sqlExecutor.oneOrNull<{
        readonly last_completed_run_id: string;
        readonly last_completed_run_number: number;
        readonly last_completed_sha: string;
        readonly version: number;
      }>(
        `select last_completed_run_id, last_completed_run_number,
                last_completed_sha, version
         from ${RELEASE_NOTE_STREAM_STATES_TABLE}
         where stream_key = :streamKey`,
        { streamKey: stream.key }
      );
      expect(completed).toEqual({
        status: ReleaseNotePublicationStatus.Completed,
        next_part: 12
      });
      expect(cursor).toEqual({
        last_completed_run_id: currentRun.id,
        last_completed_run_number: currentRun.number,
        last_completed_sha: currentRun.sha,
        version: 1
      });
    });

    it('blocks a newer run while an earlier publication is incomplete', async () => {
      await repository.preparePublication(
        {
          publicationId: 'publication-id',
          stream,
          currentRun,
          bootstrapPreviousRun: previousRun
        },
        {}
      );

      await expect(
        repository.preparePublication(
          {
            publicationId: 'newer-publication-id',
            stream,
            currentRun: {
              id: '32472000000',
              number: 1661,
              sha: 'cccccccccccccccccccccccccccccccccccccccc'
            },
            bootstrapPreviousRun: null
          },
          {}
        )
      ).rejects.toThrow('run 1660 must complete before run 1661');
    });
  }
);
