import { WavesApiDb } from './waves.api.db';

function createRepo() {
  const db = {
    oneOrNull: jest.fn()
  };
  return {
    db,
    repo: new WavesApiDb(() => db as any)
  };
}

describe('WavesApiDb DM unread drops count', () => {
  it('counts unread DM drops for the reader', async () => {
    const { db, repo } = createRepo();
    const timer = {
      start: jest.fn(),
      stop: jest.fn()
    };
    db.oneOrNull.mockResolvedValue({ count: '4' });

    await expect(
      repo.countIdentityUnreadDmDrops({ identityId: 'reader-1' }, {
        timer
      } as any)
    ).resolves.toBe(4);

    expect(db.oneOrNull).toHaveBeenCalledWith(
      expect.stringContaining('w.is_direct_message = true'),
      { identityId: 'reader-1' },
      { wrappedConnection: undefined }
    );
    expect(db.oneOrNull).toHaveBeenCalledWith(
      expect.stringContaining('d.author_id != :identityId'),
      expect.anything(),
      expect.anything()
    );
    expect(db.oneOrNull).toHaveBeenCalledWith(
      expect.stringContaining('r.muted = false'),
      expect.anything(),
      expect.anything()
    );
    expect(timer.start).toHaveBeenCalledWith(
      'WavesApiDb->countIdentityUnreadDmDrops'
    );
    expect(timer.stop).toHaveBeenCalledWith(
      'WavesApiDb->countIdentityUnreadDmDrops'
    );
  });

  it('returns zero when no count row is returned', async () => {
    const { db, repo } = createRepo();
    db.oneOrNull.mockResolvedValue(null);

    await expect(
      repo.countIdentityUnreadDmDrops({ identityId: 'reader-1' }, {})
    ).resolves.toBe(0);
  });
});
