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
