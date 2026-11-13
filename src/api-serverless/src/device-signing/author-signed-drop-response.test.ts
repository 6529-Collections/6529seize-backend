import { DbPoolName } from '@/db-query.options';
import { withStoredAuthorSignature } from './author-signed-drop-response';

function aDb(signedDropIds: string[]) {
  return {
    findAuthorSignedDropIds: jest
      .fn()
      .mockResolvedValue(new Set<string>(signedDropIds))
  };
}

describe('withStoredAuthorSignature', () => {
  it('marks a drop whose author signature is stored, reading the primary', async () => {
    const db = aDb(['drop-1']);

    const drop = await withStoredAuthorSignature(
      { id: 'drop-1', is_author_signed: false },
      {},
      db
    );

    expect(drop).toEqual({ id: 'drop-1', is_author_signed: true });
    expect(db.findAuthorSignedDropIds).toHaveBeenCalledWith(
      ['drop-1'],
      { timer: undefined },
      DbPoolName.WRITE
    );
  });

  it('reports a drop without a stored author signature as not signed', async () => {
    const drop = await withStoredAuthorSignature({ id: 'drop-1' }, {}, aDb([]));

    expect(drop).toEqual({ id: 'drop-1', is_author_signed: false });
  });

  it('leaves a drop whose content the viewer cannot see untouched', async () => {
    const db = aDb(['drop-1']);
    const hidden = {
      id: 'drop-1',
      is_author_signed: false,
      moderation: { can_view: false }
    };

    await expect(withStoredAuthorSignature(hidden, {}, db)).resolves.toBe(
      hidden
    );
    expect(db.findAuthorSignedDropIds).not.toHaveBeenCalled();
  });

  it('keeps the mapped drop when the status cannot be read', async () => {
    const mapped = { id: 'drop-1', is_author_signed: false };
    const db = {
      findAuthorSignedDropIds: jest
        .fn()
        .mockRejectedValue(new Error('db unavailable'))
    };

    await expect(withStoredAuthorSignature(mapped, {}, db)).resolves.toBe(
      mapped
    );
  });
});
