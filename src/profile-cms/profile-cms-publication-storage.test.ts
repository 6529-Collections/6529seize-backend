import { Response } from 'node-fetch';
import fetch from 'node-fetch';
import { ArweaveFileUploader } from '@/arweave';
import { ProfileCmsUploadsDb } from '@/profile-cms/profile-cms-uploads.db';
import {
  CMS_MAX_STORAGE_BYTES,
  cmsBytesHash,
  ProfileCmsPublicationStorage
} from './profile-cms-publication-storage';
import { CmsPackageV1 } from './protocol/v1';

const bytes = Buffer.from('{"content":"durable"}');
const receipt: CmsPackageV1['storage'][number] = {
  provider: 'arweave',
  uri: `ar://${'a'.repeat(43)}`,
  content_hash: cmsBytesHash(bytes),
  canonical: true,
  recorded_at: '2026-09-10T00:00:00.000Z'
};

describe('CMS durable storage', () => {
  const originalKey = process.env.ARWEAVE_KEY;
  afterEach(() => {
    if (originalKey === undefined) delete process.env.ARWEAVE_KEY;
    else process.env.ARWEAVE_KEY = originalKey;
  });

  it('retrieves bounded bytes from an allowlisted gateway and checks their actual hash', async () => {
    const download = jest.fn().mockResolvedValue(new Response(bytes));
    const storage = new ProfileCmsPublicationStorage(
      undefined,
      undefined,
      download as unknown as typeof fetch
    );
    await expect(storage.verify(receipt)).resolves.toEqual(bytes);
    expect(download).toHaveBeenCalledWith(
      `https://arweave.net/${'a'.repeat(43)}`,
      expect.objectContaining({
        redirect: 'error',
        timeout: 8000,
        size: CMS_MAX_STORAGE_BYTES,
        signal: expect.any(AbortSignal)
      })
    );
  });

  it('rejects unavailable bytes without accepting a declared receipt as proof', async () => {
    const download = jest
      .fn()
      .mockResolvedValue(new Response('', { status: 404 }));
    const storage = new ProfileCmsPublicationStorage(
      undefined,
      undefined,
      download as unknown as typeof fetch
    );
    await expect(storage.verify(receipt)).rejects.toMatchObject({
      code: 'cms_storage_pending'
    });
  });

  it('rejects hash mismatches and unsupported URLs before following redirects or arbitrary hosts', async () => {
    const download = jest.fn().mockResolvedValue(new Response('different'));
    const storage = new ProfileCmsPublicationStorage(
      undefined,
      undefined,
      download as unknown as typeof fetch
    );
    await expect(storage.verify(receipt)).rejects.toMatchObject({
      code: 'cms_storage_hash_mismatch'
    });
    download.mockClear();
    await expect(
      storage.verify({
        ...receipt,
        uri: 'http://169.254.169.254/latest/meta-data'
      })
    ).rejects.toThrow('root IPFS or Arweave');
    expect(download).not.toHaveBeenCalled();
  });

  it('aborts a stalled gateway at the wall-clock deadline', async () => {
    jest.useFakeTimers();
    try {
      const download = jest.fn(
        (_url: string, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) =>
            options.signal.addEventListener('abort', () =>
              reject(new Error('aborted'))
            )
          )
      );
      const storage = new ProfileCmsPublicationStorage(
        undefined,
        undefined,
        download as unknown as typeof fetch
      );
      const result = expect(storage.verify(receipt)).rejects.toMatchObject({
        code: 'cms_storage_pending'
      });
      await jest.advanceTimersByTimeAsync(8000);
      await result;
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects oversized native identifiers before making a gateway request', async () => {
    const download = jest.fn();
    const storage = new ProfileCmsPublicationStorage(
      undefined,
      undefined,
      download as unknown as typeof fetch
    );
    await expect(
      storage.verify({ ...receipt, uri: 'ipfs://b' + 'a'.repeat(257) })
    ).rejects.toThrow('root IPFS or Arweave');
    expect(download).not.toHaveBeenCalled();
  });

  it('returns a durable reservation receipt on retries without paying for another upload', async () => {
    process.env.ARWEAVE_KEY = 'configured-for-test';
    const uploads = {
      reserve: jest.fn().mockResolvedValue({ id: 'id', receipt }),
      complete: jest.fn(),
      release: jest.fn()
    };
    const uploader = { uploadFileWithTransactionId: jest.fn() };
    const storage = new ProfileCmsPublicationStorage(
      uploads as unknown as ProfileCmsUploadsDb,
      uploader as unknown as ArweaveFileUploader
    );
    await expect(
      storage.upload(
        {
          operationKey: 'draft:body:hash',
          profileId: 'profile',
          packageDbId: 'draft',
          bytes
        },
        {}
      )
    ).resolves.toEqual(receipt);
    expect(uploader.uploadFileWithTransactionId).not.toHaveBeenCalled();
  });

  it('rejects oversized uploads before quota reservation or network activity', async () => {
    const uploads = { reserve: jest.fn() };
    const storage = new ProfileCmsPublicationStorage(
      uploads as unknown as ProfileCmsUploadsDb
    );
    await expect(
      storage.upload(
        {
          operationKey: 'oversize',
          profileId: 'profile',
          packageDbId: 'draft',
          bytes: Buffer.alloc(CMS_MAX_STORAGE_BYTES + 1)
        },
        {}
      )
    ).rejects.toThrow('2 MiB');
    expect(uploads.reserve).not.toHaveBeenCalled();
  });
});
