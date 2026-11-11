import { DbPoolName } from '@/db-query.options';
import { MemeCollaborationsService } from './meme-collaborations.service';
import type { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { SqlExecutor } from '@/sql-executor';
import { MemeCollaborationsDb } from './meme-collaborations.db';

it('reads collaboration integrity and invitation state from the primary, preserving a provided transaction', async () => {
  const execute = jest.fn().mockResolvedValue([]);
  const db = new MemeCollaborationsDb(
    () => ({ execute }) as unknown as SqlExecutor
  );
  await db.context('drop', {});
  expect(execute).toHaveBeenLastCalledWith(
    expect.any(String),
    { dropId: 'drop' },
    { forcePool: DbPoolName.WRITE }
  );
  await db.invitations('drop', {});
  expect(execute).toHaveBeenLastCalledWith(
    expect.any(String),
    { dropId: 'drop' },
    { forcePool: DbPoolName.WRITE }
  );
  const connection = { connection: {} };
  await db.context('drop', { connection }, true);
  expect(execute).toHaveBeenLastCalledWith(
    expect.stringContaining('for update'),
    { dropId: 'drop' },
    { wrappedConnection: connection }
  );
});

it('rejects edit-time invitation changes before querying or mutating collaboration state', async () => {
  const db = {} as MemeCollaborationsDb;
  const service = new MemeCollaborationsService(db);
  const model = {
    drop_id: 'drop',
    collaborator_ids: ['B']
  } as CreateOrUpdateDropModel;
  await expect(service.onWrite(model, 'drop', {})).rejects.toThrow(
    'only be set when submitting'
  );
});

it('uses active designated native Main Stage membership, including transferred original submissions, independently of stored drop type', async () => {
  const execute = jest.fn().mockResolvedValue([]);
  const db = new MemeCollaborationsDb(
    () => ({ execute }) as unknown as SqlExecutor
  );
  expect(await db.activeMainStageDrop('drop', {})).toBeNull();
  const sql = execute.mock.calls[0][0];
  expect(sql).toContain("cap.capability = 'MAIN_STAGE'");
  expect(sql).toContain("entry.status = 'ACTIVE'");
  expect(sql).toContain("competition.lifecycle = 'PUBLISHED'");
  expect(sql).toContain('native_entry.drop_id=d.id');
  expect(sql).not.toContain('d.drop_type');
  expect(sql).not.toContain('wave_decision_winner_drops');
  expect(execute.mock.calls[0][2]).toEqual({ forcePool: DbPoolName.WRITE });
});

it('uses confirmed names in live credit formatting while preserving an already frozen credit', async () => {
  const saved = {
    artist: 'Legacy A, Legacy B',
    artist_profiles: 'oldA, oldB',
    collab: true
  };
  const context = {
    drop_id: 'drop',
    base_artist: 'Artist A',
    current_author_handle: 'userA',
    credit: null as typeof saved | null
  };
  const db = new MemeCollaborationsDb(
    () =>
      ({ execute: jest.fn(async () => [context]) }) as unknown as SqlExecutor
  );
  const profiles = {
    drop: [{ id: 'B', handle: 'userB', display: 'Artist B Name', pfp: null }]
  };
  expect(
    (await db.presentationByDrops(['drop'], {}, profiles)).drop.credit
  ).toEqual({
    artist: 'Artist A & Artist B Name',
    artist_profiles: 'userA, userB',
    collab: true
  });
  context.credit = saved;
  expect(
    (await db.presentationByDrops(['drop'], {}, profiles)).drop.credit
  ).toEqual(saved);
});
