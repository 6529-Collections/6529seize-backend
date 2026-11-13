import {
  DROP_METADATA_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
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

    it('orders completed ranges by deployment time and verifies the drop identity', async () => {
      const waveId = 'deploy-wave';
      const authorId = 'bot-profile';
      const deployedAt = '2026-11-10T15:20:15.890Z';
      const nextRun = {
        id: '32472000000',
        number: 1661,
        sha: 'cccccccccccccccccccccccccccccccccccccccc'
      };

      async function recordRange(run: typeof currentRun, timestamp: string) {
        const publicationId = `publication-${run.number}`;
        const dropId = `frontend-drop-${run.number}`;
        await repository.preparePublication(
          {
            publicationId,
            stream,
            currentRun: run,
            bootstrapPreviousRun: previousRun
          },
          {}
        );
        await sqlExecutor.execute(
          `insert into ${DROPS_TABLE} (id, serial_no, wave_id, author_id, created_at, parts_count)
           values (:dropId, :serialNo, :waveId, :authorId, 1, 1)`,
          { dropId, serialNo: run.number, waveId, authorId }
        );
        await sqlExecutor.execute(
          `insert into ${DROPS_PARTS_TABLE} (drop_id, drop_part_id, content)
           values (:dropId, 1, :content)`,
          { dropId, content: 'Frontend heading\nBody' }
        );
        await sqlExecutor.execute(
          `insert into ${DROP_METADATA_TABLE} (drop_id, wave_id, data_key, data_value)
           values (:dropId, :waveId, 'release_note_deployed_at', :timestamp),
                  (:dropId, :waveId, 'release_note_repository', :repo),
                  (:dropId, :waveId, 'release_note_sha', :sha)`,
          { dropId, waveId, timestamp, repo: stream.repository, sha: run.sha }
        );
        await repository.recordPlan(publicationId, 1, {});
        await repository.recordPart(
          { publicationId, partNumber: 1, totalParts: 1, dropId },
          {}
        );
        return { publicationId, dropId };
      }

      const filter = {
        repository: stream.repository,
        waveIds: [waveId, 'legacy-wave'],
        authorId
      };
      const first = await recordRange(currentRun, deployedAt);
      await expect(
        repository.findPublishedFrontendReleaseRanges(filter, {})
      ).resolves.toEqual([]);

      await repository.completePublication(first.publicationId, {});
      const second = await recordRange(
        nextRun,
        '2026-11-10T17:00:00.000+02:00'
      );
      await repository.completePublication(second.publicationId, {});

      await expect(
        repository.findPublishedFrontendReleaseRanges(filter, {})
      ).resolves.toEqual([
        expect.objectContaining({
          id: second.dropId,
          serial_no: nextRun.number,
          previous_sha: currentRun.sha,
          current_sha: nextRun.sha
        }),
        expect.objectContaining({
          id: first.dropId,
          serial_no: currentRun.number,
          wave_id: waveId,
          run_number: String(currentRun.number),
          previous_sha: previousRun.sha,
          current_sha: currentRun.sha,
          deployed_at: deployedAt,
          content: 'Frontend heading'
        })
      ]);
      await sqlExecutor.execute(
        `update ${DROP_METADATA_TABLE} set data_value = '6529-Collections/6529seize-backend'
         where drop_id = :dropId and data_key = 'release_note_repository'`,
        { dropId: second.dropId }
      );
      await expect(
        repository.findPublishedFrontendReleaseRanges(filter, {})
      ).resolves.toEqual([expect.objectContaining({ id: first.dropId })]);
      await expect(
        repository.findPublishedFrontendReleaseRanges(
          { ...filter, authorId: 'other-profile' },
          {}
        )
      ).resolves.toEqual([]);
    });

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
        repository.recordPlan('publication-id', 12, {})
      ).rejects.toThrow('changed its total part count');
      await expect(
        repository.completePublication('publication-id', {})
      ).rejects.toThrow('has unfinished parts');
      await expect(
        repository.recordPart(
          {
            publicationId: 'publication-id',
            partNumber: 2,
            totalParts: 11,
            dropId: 'out-of-order-part-drop'
          },
          {}
        )
      ).rejects.toThrow('cannot record out-of-order part 2');
      for (let partNumber = 1; partNumber <= 6; partNumber++) {
        await repository.recordPart(
          {
            publicationId: 'publication-id',
            partNumber,
            totalParts: 11,
            dropId: `part-${partNumber}-drop`
          },
          {}
        );
      }

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
        last_drop_id: 'part-6-drop'
      });

      await expect(
        repository.completePublication('publication-id', {})
      ).rejects.toThrow('has unfinished parts');
      for (let partNumber = 7; partNumber <= 11; partNumber++) {
        await repository.recordPart(
          {
            publicationId: 'publication-id',
            partNumber,
            totalParts: 11,
            dropId: `part-${partNumber}-drop`
          },
          {}
        );
      }
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
      await expect(
        repository.recordPart(
          {
            publicationId: 'publication-id',
            partNumber: 11,
            totalParts: 11,
            dropId: 'late-part-eleven-drop'
          },
          {}
        )
      ).rejects.toThrow('is already completed');
    });

    it('advances the cursor when the release range has no pull requests', async () => {
      await repository.preparePublication(
        {
          publicationId: 'empty-publication-id',
          stream,
          currentRun,
          bootstrapPreviousRun: previousRun
        },
        {}
      );

      await repository.recordPlan('empty-publication-id', 0, {});
      await repository.completePublication('empty-publication-id', {});

      const publication = await sqlExecutor.oneOrNull<{
        readonly status: string;
        readonly total_parts: number | null;
        readonly next_part: number;
      }>(
        `select status, total_parts, next_part
         from ${RELEASE_NOTE_PUBLICATIONS_TABLE}
         where publication_id = :publicationId`,
        { publicationId: 'empty-publication-id' }
      );
      const cursor = await sqlExecutor.oneOrNull<{
        readonly last_completed_run_number: number;
        readonly last_completed_sha: string;
      }>(
        `select last_completed_run_number, last_completed_sha
         from ${RELEASE_NOTE_STREAM_STATES_TABLE}
         where stream_key = :streamKey`,
        { streamKey: stream.key }
      );
      expect(publication).toEqual({
        status: ReleaseNotePublicationStatus.Completed,
        total_parts: 0,
        next_part: 1
      });
      expect(cursor).toEqual({
        last_completed_run_number: currentRun.number,
        last_completed_sha: currentRun.sha
      });
    });

    it('supersedes a publication when its frozen stream baseline no longer matches', async () => {
      await repository.preparePublication(
        {
          publicationId: 'mismatched-publication-id',
          stream,
          currentRun,
          bootstrapPreviousRun: previousRun
        },
        {}
      );
      await sqlExecutor.execute(
        `update ${RELEASE_NOTE_STREAM_STATES_TABLE}
         set last_completed_sha = :sha
         where stream_key = :streamKey`,
        {
          streamKey: stream.key,
          sha: 'dddddddddddddddddddddddddddddddddddddddd'
        }
      );

      await repository.completePublication('mismatched-publication-id', {});

      const publication = await sqlExecutor.oneOrNull<{
        readonly status: string;
      }>(
        `select status
         from ${RELEASE_NOTE_PUBLICATIONS_TABLE}
         where publication_id = :publicationId`,
        { publicationId: 'mismatched-publication-id' }
      );
      expect(publication).toEqual({
        status: ReleaseNotePublicationStatus.Superseded
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
      ).resolves.toEqual({ blockedByRunNumber: 1660 });
    });
  }
);
