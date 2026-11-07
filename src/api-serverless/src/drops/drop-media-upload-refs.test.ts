import { withOwnedMediaUploadIds } from '@/api/drops/drop-media-upload-refs';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropType } from '@/entities/IDrop';
import {
  DropMediaUploadEntity,
  DropMediaUploadStatus
} from '@/entities/IDropMediaUpload';

const URL_A = 'https://d3lqz0a4bldqgf.cloudfront.net/drops/a/photo.jpg';
const URL_B = 'https://d3lqz0a4bldqgf.cloudfront.net/drops/b/anim.gif';

function upload(
  id: string,
  overrides: Partial<DropMediaUploadEntity> = {}
): DropMediaUploadEntity {
  return {
    id,
    profile_id: 'author-1',
    public_url: URL_A,
    declared_mime_type: 'image/jpeg',
    status: DropMediaUploadStatus.READY,
    drop_id: null,
    wave_id: null,
    ...overrides
  } as DropMediaUploadEntity;
}

function model(
  overrides: Partial<CreateOrUpdateDropModel> = {}
): CreateOrUpdateDropModel {
  return {
    drop_id: null,
    wave_id: 'wave-1',
    author_id: 'author-1',
    author_identity: 'author-1',
    drop_type: DropType.CHAT,
    title: null,
    reply_to: null,
    signature: null,
    metadata: [],
    mentioned_users: [],
    mentioned_waves: [],
    referenced_nfts: [],
    parts: [
      {
        content: 'hi',
        quoted_drop: null,
        media: [
          { url: URL_A, mime_type: 'image/jpeg' },
          { url: URL_B, mime_type: 'image/gif' }
        ]
      }
    ],
    ...overrides
  } as CreateOrUpdateDropModel;
}

const request = (ids: (string | null | undefined)[]) => ({
  parts: [{ media: ids.map((media_upload_id) => ({ media_upload_id })) }]
});

const idsOf = (result: CreateOrUpdateDropModel) =>
  result.parts[0].media.map((media) => media.media_upload_id);

describe('withOwnedMediaUploadIds (R11-2)', () => {
  it('keeps the ids of the author’s own uploads for these URLs', async () => {
    const uploads = new Map([
      ['u-a', upload('u-a')],
      [
        'u-b',
        upload('u-b', {
          public_url: URL_B,
          declared_mime_type: 'image/gif',
          status: DropMediaUploadStatus.PROCESSING
        })
      ]
    ]);
    const db = { findById: jest.fn(async (id: string) => uploads.get(id)!) };

    const result = await withOwnedMediaUploadIds(
      model(),
      request(['u-a', 'u-b']),
      {},
      db
    );

    expect(idsOf(result)).toEqual(['u-a', 'u-b']);
  });

  it('drops every id it cannot vouch for, so the post still goes through', async () => {
    const cases: Partial<DropMediaUploadEntity>[] = [
      { profile_id: 'someone-else' }, // e.g. a proxy's own upload
      { public_url: URL_B }, // another file
      { declared_mime_type: 'image/png' }, // another type
      { status: DropMediaUploadStatus.FAILED },
      { status: DropMediaUploadStatus.UPLOADING },
      { drop_id: 'other-drop' }, // attached to another drop
      { wave_id: 'other-wave' }
    ];
    for (const overrides of cases) {
      const db = {
        findById: jest.fn(async () => upload('u-a', overrides))
      };
      const result = await withOwnedMediaUploadIds(
        model(),
        request(['u-a', null]),
        {},
        db
      );
      expect({ overrides, ids: idsOf(result) }).toEqual({
        overrides,
        ids: [null, null]
      });
    }
  });

  it('drops an unknown id and keeps the post unchanged when the lookup fails', async () => {
    const missing = await withOwnedMediaUploadIds(
      model(),
      request(['nope']),
      {},
      { findById: jest.fn(async () => null) }
    );
    expect(idsOf(missing)).toEqual([null, null]);

    const original = model();
    const failed = await withOwnedMediaUploadIds(
      original,
      request(['u-a']),
      {},
      {
        findById: jest.fn(async () => {
          throw new Error('db down');
        })
      }
    );
    expect(failed).toBe(original);
  });

  it('accepts the JPEG alias and an AVIF upload published as WebP', async () => {
    const db = {
      findById: jest.fn(async (id: string) =>
        id === 'u-a'
          ? upload('u-a')
          : upload('u-b', {
              public_url: URL_B,
              declared_mime_type: 'image/avif'
            })
      )
    };
    const result = await withOwnedMediaUploadIds(
      model({
        parts: [
          {
            content: null,
            quoted_drop: null,
            media: [
              { url: URL_A, mime_type: 'image/jpg' },
              { url: URL_B, mime_type: 'image/webp' }
            ]
          }
        ]
      } as Partial<CreateOrUpdateDropModel>),
      request(['u-a', 'u-b']),
      {},
      db
    );
    expect(idsOf(result)).toEqual(['u-a', 'u-b']);
  });

  it('keeps an upload attached to the drop being edited or to a replay’s published drop', async () => {
    const attached = {
      findById: jest.fn(async () =>
        upload('u-a', { drop_id: 'drop-1', wave_id: 'wave-1' })
      )
    };

    const edit = await withOwnedMediaUploadIds(
      model({ drop_id: 'drop-1' }),
      request(['u-a']),
      {},
      attached
    );
    const replay = await withOwnedMediaUploadIds(
      model(),
      request(['u-a']),
      { publishedDropId: 'drop-1' },
      attached
    );
    const fresh = await withOwnedMediaUploadIds(
      model(),
      request(['u-a']),
      {},
      attached
    );

    expect(idsOf(edit)[0]).toBe('u-a');
    expect(idsOf(replay)[0]).toBe('u-a');
    expect(idsOf(fresh)[0]).toBeNull();
  });

  it('resolves a replay exactly as the published attempt did, whatever the status is now', async () => {
    const resolveReplay = (overrides: Partial<DropMediaUploadEntity>) =>
      withOwnedMediaUploadIds(
        model(),
        request(['u-a']),
        { publishedDropId: 'drop-1' },
        { findById: jest.fn(async () => upload('u-a', overrides)) }
      ).then((result) => idsOf(result)[0]);

    // The published attempt kept it (and so attached it); it failed later.
    expect(
      await resolveReplay({
        drop_id: 'drop-1',
        wave_id: 'wave-1',
        status: DropMediaUploadStatus.FAILED
      })
    ).toBe('u-a');
    // The published attempt did not keep it, so it was never attached.
    expect(await resolveReplay({ drop_id: null })).toBeNull();
    expect(await resolveReplay({ drop_id: 'other-drop' })).toBeNull();
    // Still never another author's upload.
    expect(
      await resolveReplay({ drop_id: 'drop-1', profile_id: 'someone-else' })
    ).toBeNull();
  });

  it('does not touch the database when no media names an upload', async () => {
    const db = { findById: jest.fn() };
    const original = model();
    await expect(
      withOwnedMediaUploadIds(original, request([undefined, null]), {}, db)
    ).resolves.toBe(original);
    expect(db.findById).not.toHaveBeenCalled();
  });
});
