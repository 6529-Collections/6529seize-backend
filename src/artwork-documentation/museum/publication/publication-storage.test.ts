import {
  PUBLICATION_CACHE_CONTROL,
  PUBLICATION_CONTENT_TYPE,
  publicationObjectKey,
  S3PublicationStorage
} from './publication.storage';

describe('Publication immutable storage', () => {
  const publication = {
    id: '10000000-0000-4000-8000-000000000001',
    manifest_sha256: 'a'.repeat(64),
    manifest_json:
      '{"@context":"http://iiif.io/api/presentation/3/context.json"}'
  };
  it('skips storage when no bucket is configured', async () => {
    const upload = jest.fn();
    const storage = new S3PublicationStorage(upload, () => undefined);
    await expect(storage.store(publication)).resolves.toBeNull();
    expect(upload).not.toHaveBeenCalled();
  });
  it('writes an immutable manifest object under the publication and digest key', async () => {
    const upload = jest.fn(
      async (_input: { body: Buffer } & Record<string, unknown>) => ({})
    );
    const storage = new S3PublicationStorage(
      upload,
      () => 'publication-bucket'
    );
    await expect(storage.store(publication)).resolves.toBe(
      `museum/publications/${publication.id}/${publication.manifest_sha256}/manifest.json`
    );
    expect(upload).toHaveBeenCalledTimes(1);
    const call = upload.mock.calls[0][0];
    expect(call).toMatchObject({
      bucket: 'publication-bucket',
      key: publicationObjectKey(publication.id, publication.manifest_sha256),
      contentType: PUBLICATION_CONTENT_TYPE,
      txId: publication.manifest_sha256,
      cacheControl: PUBLICATION_CACHE_CONTROL
    });
    expect(PUBLICATION_CACHE_CONTROL).toBe(
      'public, max-age=31536000, immutable'
    );
    expect((call.body as Buffer).toString('utf8')).toBe(
      publication.manifest_json
    );
  });
  it('propagates upload failures to the caller', async () => {
    const storage = new S3PublicationStorage(
      jest.fn(async () => {
        throw new Error('denied');
      }),
      () => 'publication-bucket'
    );
    await expect(storage.store(publication)).rejects.toThrow('denied');
  });
});
