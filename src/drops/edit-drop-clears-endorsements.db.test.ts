import 'reflect-metadata';
import {
  DROP_CURATIONS_TABLE,
  DROP_POLL_OPTIONS_TABLE,
  DROP_POLL_VOTES_TABLE,
  DROP_POLLS_TABLE,
  DROP_REACTIONS_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  WAVE_CURATIONS_TABLE
} from '@/constants';
import { createOrUpdateDrop } from '@/drops/create-or-update-drop.use-case';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropType } from '@/entities/IDrop';
import { WaveType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { Time } from '@/time';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';

/**
 * C10 regression: editing a drop must clear the endorsements it collected.
 *
 * Reactions, poll votes and curations endorse the content a person saw. An
 * edit can change that content, so keeping them would let an author collect
 * endorsements and then swap the text ("bait and switch"). Today the edit
 * reuses the delete path; this test protects the observable outcome rather
 * than that mechanism, so a future rewrite of the write path still has to
 * keep it.
 */

const wave = aWave(
  { type: WaveType.CHAT, chat_enabled: true },
  { id: 'c10-wave', name: 'C10 wave' }
);
const authorId = 'c10-author';
const editedDropId = 'c10-edited-drop';
const untouchedDropId = 'c10-untouched-drop';
const curationId = 'c10-curation';
const reactorIds = ['c10-reactor-1', 'c10-reactor-2', 'c10-reactor-3'];
const createdAt = Time.currentMillis() - 1_000;

function dropRow(id: string, serialNo: number) {
  return {
    serial_no: serialNo,
    id,
    wave_id: wave.id,
    author_id: authorId,
    created_at: createdAt,
    updated_at: null,
    title: null,
    parts_count: 1,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    drop_type: DropType.CHAT,
    signature: null,
    is_additional_action_promised: null,
    hide_link_preview: false
  };
}

function partRow(dropId: string, content: string) {
  return {
    drop_id: dropId,
    drop_part_id: 1,
    content,
    quoted_drop_id: null,
    quoted_drop_part_id: null,
    wave_id: wave.id
  };
}

function reactionRows(dropId: string) {
  return reactorIds.map((profileId, index) => ({
    profile_id: profileId,
    wave_id: wave.id,
    drop_id: dropId,
    reaction: index === 0 ? ':fire:' : ':+1:'
  }));
}

function pollRows(dropId: string) {
  const pollId = `${dropId}-poll`;
  return {
    poll: {
      id: pollId,
      wave_id: wave.id,
      drop_id: dropId,
      closing_time: Time.currentMillis() + Time.days(1).toMillis(),
      multichoice: true,
      anonymous: false,
      only_droppers_can_respond: false
    },
    options: [1, 2].map((optionNo) => ({
      poll_id: pollId,
      option_no: optionNo,
      wave_id: wave.id,
      drop_id: dropId,
      option_string: `Option ${optionNo}`
    })),
    votes: reactorIds.map((voterId, index) => ({
      poll_id: pollId,
      wave_id: wave.id,
      drop_id: dropId,
      option_no: (index % 2) + 1,
      vote_time: createdAt + index,
      voter_id: voterId
    }))
  };
}

function curationRow(dropId: string, priorityOrder: number) {
  return {
    drop_id: dropId,
    curation_id: curationId,
    created_at: createdAt,
    updated_at: createdAt,
    wave_id: wave.id,
    curated_by: reactorIds[0],
    priority_order: priorityOrder
  };
}

const editedPoll = pollRows(editedDropId);
const untouchedPoll = pollRows(untouchedDropId);

const editModel: CreateOrUpdateDropModel = {
  drop_id: editedDropId,
  wave_id: wave.id,
  author_id: authorId,
  author_identity: authorId,
  drop_type: DropType.CHAT,
  signature: null,
  title: null,
  reply_to: null,
  parts: [{ content: 'Edited text', quoted_drop: null, media: [] }],
  metadata: [],
  mentioned_users: [],
  mentioned_waves: [],
  mentioned_groups: [],
  referenced_nfts: [],
  is_additional_action_promised: null
};

async function countFor(table: string, dropId: string): Promise<number> {
  const row = await sqlExecutor.oneOrNull<{ cnt: number }>(
    `select count(*) as cnt from ${table} where drop_id = :dropId`,
    { dropId }
  );
  return Number(row?.cnt ?? 0);
}

async function endorsementCounts(dropId: string) {
  return {
    reactions: await countFor(DROP_REACTIONS_TABLE, dropId),
    pollVotes: await countFor(DROP_POLL_VOTES_TABLE, dropId),
    curations: await countFor(DROP_CURATIONS_TABLE, dropId)
  };
}

async function editDrop(model: CreateOrUpdateDropModel = editModel) {
  return sqlExecutor.executeNativeQueriesInTransaction((connection) =>
    createOrUpdateDrop.execute(model, false, {
      connection,
      prePublication: { trustedSystem: true }
    })
  );
}

describeWithSeed(
  'Editing a drop clears its endorsements (C10)',
  [
    withWaves([wave]),
    {
      table: DROPS_TABLE,
      rows: [dropRow(editedDropId, 501), dropRow(untouchedDropId, 502)]
    },
    {
      table: DROPS_PARTS_TABLE,
      rows: [
        partRow(editedDropId, 'Original text'),
        partRow(untouchedDropId, 'Neighbour text')
      ]
    },
    {
      table: DROP_REACTIONS_TABLE,
      rows: [...reactionRows(editedDropId), ...reactionRows(untouchedDropId)]
    },
    { table: DROP_POLLS_TABLE, rows: [editedPoll.poll, untouchedPoll.poll] },
    {
      table: DROP_POLL_OPTIONS_TABLE,
      rows: [...editedPoll.options, ...untouchedPoll.options]
    },
    {
      table: DROP_POLL_VOTES_TABLE,
      rows: [...editedPoll.votes, ...untouchedPoll.votes]
    },
    {
      table: WAVE_CURATIONS_TABLE,
      rows: [
        {
          id: curationId,
          name: 'C10 picks',
          wave_id: wave.id,
          community_group_id: 'c10-curators',
          created_at: createdAt,
          updated_at: createdAt,
          priority_order: 1
        }
      ]
    },
    {
      table: DROP_CURATIONS_TABLE,
      rows: [curationRow(editedDropId, 1), curationRow(untouchedDropId, 2)]
    }
  ],
  () => {
    const previousMaxEditTime = process.env.MAX_DROP_EDIT_TIME_MS;

    beforeEach(() => {
      process.env.MAX_DROP_EDIT_TIME_MS = `${Time.hours(1).toMillis()}`;
    });

    afterEach(() => {
      if (previousMaxEditTime === undefined) {
        delete process.env.MAX_DROP_EDIT_TIME_MS;
      } else {
        process.env.MAX_DROP_EDIT_TIME_MS = previousMaxEditTime;
      }
    });

    it('starts with endorsements on both drops', async () => {
      const expected = { reactions: 3, pollVotes: 3, curations: 1 };
      expect(await endorsementCounts(editedDropId)).toEqual(expected);
      expect(await endorsementCounts(untouchedDropId)).toEqual(expected);
    });

    it('clears reactions, poll votes and curations of the edited drop', async () => {
      const result = await editDrop();

      expect(result.drop_id).toBe(editedDropId);
      expect(await endorsementCounts(editedDropId)).toEqual({
        reactions: 0,
        pollVotes: 0,
        curations: 0
      });
    });

    it('keeps the edited drop in place with the new content', async () => {
      await editDrop();

      const drop = await sqlExecutor.oneOrNull<{
        serial_no: number;
        created_at: number;
        updated_at: number | null;
      }>(
        `select serial_no, created_at, updated_at from ${DROPS_TABLE} where id = :id`,
        { id: editedDropId }
      );
      expect(drop).not.toBeNull();
      expect(Number(drop!.serial_no)).toBe(501);
      expect(Number(drop!.created_at)).toBe(createdAt);
      expect(drop!.updated_at).not.toBeNull();
      const parts = await sqlExecutor.execute<{ content: string }>(
        `select content from ${DROPS_PARTS_TABLE} where drop_id = :id`,
        { id: editedDropId }
      );
      expect(parts.map((part) => part.content)).toEqual(['Edited text']);
    });

    it('leaves the endorsements of other drops alone', async () => {
      await editDrop();

      expect(await endorsementCounts(untouchedDropId)).toEqual({
        reactions: 3,
        pollVotes: 3,
        curations: 1
      });
      const neighbourCuration = await sqlExecutor.oneOrNull<{
        priority_order: number;
      }>(
        `select priority_order from ${DROP_CURATIONS_TABLE} where drop_id = :id`,
        { id: untouchedDropId }
      );
      // Removing the edited drop closes the gap it left in the curation order.
      expect(Number(neighbourCuration?.priority_order)).toBe(1);
    });

    it('clears endorsements collected after an earlier edit as well', async () => {
      await editDrop();
      await sqlExecutor.execute(
        `insert into ${DROP_REACTIONS_TABLE} (profile_id, wave_id, drop_id, reaction)
         values (:profileId, :waveId, :dropId, ':heart:')`,
        { profileId: reactorIds[1], waveId: wave.id, dropId: editedDropId }
      );
      expect((await endorsementCounts(editedDropId)).reactions).toBe(1);

      await editDrop({
        ...editModel,
        parts: [{ content: 'Edited again', quoted_drop: null, media: [] }]
      });

      expect((await endorsementCounts(editedDropId)).reactions).toBe(0);
    });
  }
);
