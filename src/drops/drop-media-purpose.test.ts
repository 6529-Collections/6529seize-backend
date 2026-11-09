import fc from 'fast-check';
import { CLOUDFRONT_LINK } from '@/constants';
import { DropType } from '@/entities/IDrop';
import { DropMediaUploadPurpose } from '@/entities/IDropMediaUpload';
import {
  assertDropMediaPurposeAllowed,
  DECISION_ENTRY_MEDIA_MISUSE_MESSAGE,
  findDropMediaUploadForUrl,
  isDecisionEntryDrop,
  publicMediaKey
} from './drop-media-purpose';

const UPLOAD_ID = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';

describe('isDecisionEntryDrop', () => {
  it.each([
    [DropType.PARTICIPATORY, null, true],
    [DropType.PARTICIPATORY, { drop_id: 'parent', drop_part_id: 1 }, false],
    [DropType.CHAT, null, false],
    [DropType.CHAT, { drop_id: 'parent', drop_part_id: 1 }, false]
  ])(
    '%s with reply %j is a decision entry: %s',
    (drop_type, reply_to, expected) => {
      expect(isDecisionEntryDrop({ drop_type, reply_to })).toBe(expected);
    }
  );
});

describe('publicMediaKey', () => {
  it('maps media CDN URL variants to one object key', () => {
    const key = `drops/${UPLOAD_ID}/Final Artwork.png`;
    for (const url of [
      `${CLOUDFRONT_LINK}/drops/${UPLOAD_ID}/Final%20Artwork.png`,
      `${CLOUDFRONT_LINK}/drops/${UPLOAD_ID}/Final%20Artwork.png?x=1#y`
    ]) {
      expect(publicMediaKey(url)).toBe(key);
    }
  });

  it('ignores other origins and unparseable URLs', () => {
    expect(publicMediaKey(`https://example.com/drops/${UPLOAD_ID}/a.png`)).toBe(
      null
    );
    expect(publicMediaKey('not a url')).toBeNull();
    expect(publicMediaKey(`${CLOUDFRONT_LINK}/drops/%E0%A4%A.png`)).toBeNull();
  });
});

describe('findDropMediaUploadForUrl', () => {
  const key = `drops/${UPLOAD_ID}/${UPLOAD_ID}.jpg`;
  const db = {
    findById: jest.fn(async (id: string) =>
      id === UPLOAD_ID
        ? ({ id, public_key: key, purpose: DropMediaUploadPurpose.CHAT } as any)
        : null
    )
  };

  it('finds the upload from the folder id when it serves that key', async () => {
    await expect(
      findDropMediaUploadForUrl(`${CLOUDFRONT_LINK}/${key}`, db)
    ).resolves.toMatchObject({ id: UPLOAD_ID });
  });

  it('never looks up keys outside the drop upload layout', async () => {
    db.findById.mockClear();
    for (const url of [
      `${CLOUDFRONT_LINK}/drops/author_123/photo.jpg`,
      `${CLOUDFRONT_LINK}/waves/author_123/${UPLOAD_ID}.jpg`,
      `${CLOUDFRONT_LINK}/drops/${UPLOAD_ID}/nested/${UPLOAD_ID}.jpg`,
      `ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi`
    ]) {
      await expect(findDropMediaUploadForUrl(url, db)).resolves.toBeNull();
    }
    expect(db.findById).not.toHaveBeenCalled();
  });

  it('ignores a record that serves a different file in that folder', async () => {
    await expect(
      findDropMediaUploadForUrl(
        `${CLOUDFRONT_LINK}/drops/${UPLOAD_ID}/other.jpg`,
        db
      )
    ).resolves.toBeNull();
  });
});

describe('assertDropMediaPurposeAllowed', () => {
  it('only rejects decision entry media outside a decision entry', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          DropMediaUploadPurpose.CHAT,
          DropMediaUploadPurpose.DECISION_ENTRY,
          null,
          undefined
        ),
        fc.boolean(),
        fc.boolean(),
        (purpose, hasUpload, isDecisionEntry) => {
          const run = () =>
            assertDropMediaPurposeAllowed({
              upload: hasUpload ? { purpose } : null,
              isDecisionEntry
            });
          const rejected =
            hasUpload &&
            !isDecisionEntry &&
            purpose === DropMediaUploadPurpose.DECISION_ENTRY;
          if (rejected)
            expect(run).toThrow(DECISION_ENTRY_MEDIA_MISUSE_MESSAGE);
          else expect(run).not.toThrow();
        }
      )
    );
  });
});
