import 'reflect-metadata';
import {
  DROPS_TABLE,
  IDENTITY_MUTES_TABLE,
  WAVE_READER_METRICS_TABLE
} from '@/constants';
import { DropType } from '@/entities/IDrop';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
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
      repo.countIdentityUnreadDmDrops(
        { identityId: 'reader-1', eligibleGroups: ['group-1'] },
        {
          timer
        } as any
      )
    ).resolves.toBe(4);

    expect(db.oneOrNull).toHaveBeenCalledWith(
      expect.stringContaining('w.is_direct_message = true'),
      { identityId: 'reader-1', eligibleGroups: ['group-1'] },
      { wrappedConnection: undefined }
    );
    const sql = db.oneOrNull.mock.calls[0][0] as string;
    expect(sql).not.toContain('USE INDEX');
    expect(sql).toContain('w.visibility_group_id is null');
    expect(sql).toContain('parent.visibility_group_id is null');
    expect(sql).toContain('COALESCE(r.latest_read_timestamp, 0)');
    expect(db.oneOrNull).toHaveBeenCalledWith(
      expect.stringContaining('d.author_id != :identityId'),
      expect.anything(),
      expect.anything()
    );
    expect(db.oneOrNull).toHaveBeenCalledWith(
      expect.stringContaining(`LEFT JOIN ${IDENTITY_MUTES_TABLE}`),
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
      repo.countIdentityUnreadDmDrops(
        { identityId: 'reader-1', eligibleGroups: [] },
        {}
      )
    ).resolves.toBe(0);
  });
});

const integrationRepo = new WavesApiDb(() => sqlExecutor);
const ctx: RequestContext = { timer: undefined };

const author = anIdentity(
  {},
  {
    consolidation_key: 'identity-dm-unread-author',
    profile_id: 'profile-dm-unread-author',
    primary_address: 'wallet-dm-unread-author',
    handle: 'dm-unread-author'
  }
);
const reader = anIdentity(
  {},
  {
    consolidation_key: 'identity-dm-unread-reader',
    profile_id: 'profile-dm-unread-reader',
    primary_address: 'wallet-dm-unread-reader',
    handle: 'dm-unread-reader'
  }
);

const visibleDmWave = aWave(
  {
    created_by: author.profile_id!,
    is_direct_message: true
  },
  { id: 'dm-unread-visible-wave', serial_no: 1, name: 'Visible DM' }
);
const hiddenDmWave = aWave(
  {
    created_by: author.profile_id!,
    is_direct_message: true,
    visibility_group_id: 'dm-hidden-group'
  },
  { id: 'dm-unread-hidden-wave', serial_no: 2, name: 'Hidden DM' }
);
const mutedDmWave = aWave(
  {
    created_by: author.profile_id!,
    is_direct_message: true
  },
  { id: 'dm-unread-muted-wave', serial_no: 3, name: 'Muted DM' }
);
const nonDmWave = aWave(
  {
    created_by: author.profile_id!,
    is_direct_message: false
  },
  { id: 'dm-unread-non-dm-wave', serial_no: 4, name: 'Non-DM' }
);

function drop({
  serialNo,
  id,
  waveId,
  authorId,
  createdAt
}: {
  serialNo: number;
  id: string;
  waveId: string;
  authorId: string;
  createdAt: number;
}) {
  return {
    serial_no: serialNo,
    id,
    wave_id: waveId,
    author_id: authorId,
    created_at: createdAt,
    updated_at: null,
    title: null,
    parts_count: 1,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    drop_type: DropType.CHAT,
    signature: null,
    hide_link_preview: false
  };
}

describeWithSeed(
  'WavesApiDb DM unread drops count integration',
  [
    withIdentities([author, reader]),
    withWaves([visibleDmWave, hiddenDmWave, mutedDmWave, nonDmWave]),
    {
      table: WAVE_READER_METRICS_TABLE,
      rows: [
        {
          wave_id: visibleDmWave.id,
          reader_id: reader.profile_id!,
          latest_read_timestamp: 1000,
          muted: false
        },
        {
          wave_id: hiddenDmWave.id,
          reader_id: reader.profile_id!,
          latest_read_timestamp: 1000,
          muted: false
        },
        {
          wave_id: mutedDmWave.id,
          reader_id: reader.profile_id!,
          latest_read_timestamp: 1000,
          muted: true
        },
        {
          wave_id: nonDmWave.id,
          reader_id: reader.profile_id!,
          latest_read_timestamp: 1000,
          muted: false
        }
      ]
    },
    {
      table: DROPS_TABLE,
      rows: [
        drop({
          serialNo: 1,
          id: 'dm-read-before-timestamp',
          waveId: visibleDmWave.id,
          authorId: author.profile_id!,
          createdAt: 900
        }),
        drop({
          serialNo: 2,
          id: 'dm-first-unread',
          waveId: visibleDmWave.id,
          authorId: author.profile_id!,
          createdAt: 1100
        }),
        drop({
          serialNo: 3,
          id: 'dm-second-unread',
          waveId: visibleDmWave.id,
          authorId: author.profile_id!,
          createdAt: 1200
        }),
        drop({
          serialNo: 4,
          id: 'dm-reader-authored-unread',
          waveId: visibleDmWave.id,
          authorId: reader.profile_id!,
          createdAt: 1300
        }),
        drop({
          serialNo: 5,
          id: 'dm-hidden-unread',
          waveId: hiddenDmWave.id,
          authorId: author.profile_id!,
          createdAt: 1200
        }),
        drop({
          serialNo: 6,
          id: 'dm-muted-unread',
          waveId: mutedDmWave.id,
          authorId: author.profile_id!,
          createdAt: 1200
        }),
        drop({
          serialNo: 7,
          id: 'non-dm-unread',
          waveId: nonDmWave.id,
          authorId: author.profile_id!,
          createdAt: 1200
        })
      ]
    }
  ],
  () => {
    it('counts only visible unread DM drops for the reader', async () => {
      await expect(
        integrationRepo.countIdentityUnreadDmDrops(
          { identityId: reader.profile_id!, eligibleGroups: [] },
          ctx
        )
      ).resolves.toBe(2);

      await expect(
        integrationRepo.countIdentityUnreadDmDrops(
          {
            identityId: reader.profile_id!,
            eligibleGroups: ['dm-hidden-group']
          },
          ctx
        )
      ).resolves.toBe(3);
    });
  }
);
