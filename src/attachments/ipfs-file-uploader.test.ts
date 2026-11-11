import fetch from 'node-fetch';
import { IpfsFileUploader } from '@/attachments/ipfs-file-uploader';

jest.mock('node-fetch', () => jest.fn());

const fetchMock = fetch as unknown as jest.Mock;
const originalEndpoint = process.env.IPFS_API_ENDPOINT;
const originalUploadPath = process.env.IPFS_API_UPLOAD_PATH;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function respond(body: string, status = 200) {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body
  });
}

describe('IpfsFileUploader', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    process.env.IPFS_API_ENDPOINT = 'https://ipfs-api.example.test/';
    delete process.env.IPFS_API_UPLOAD_PATH;
  });

  afterAll(() => {
    restoreEnv('IPFS_API_ENDPOINT', originalEndpoint);
    restoreEnv('IPFS_API_UPLOAD_PATH', originalUploadPath);
  });

  it('pins a single file without a wrapping directory', async () => {
    respond('{"Name":"pfp.png","Hash":"QmSingleFile","Size":"10"}\n');

    await expect(
      new IpfsFileUploader().uploadFile({
        fileName: 'pfp.png',
        fileBuffer: Buffer.from('png'),
        contentType: 'image/png'
      })
    ).resolves.toEqual({ cid: 'QmSingleFile', url: 'ipfs://QmSingleFile' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ipfs-api.example.test/api/v0/add?pin=true',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('keeps directory uploads wrapped and addressed by the root cid', async () => {
    respond(
      [
        '{"Name":"index.html","Hash":"QmChild"}',
        '{"Name":"","Hash":"QmRoot"}'
      ].join('\n')
    );

    await expect(
      new IpfsFileUploader().uploadDirectory({
        files: [
          {
            fileName: 'index.html',
            fileBuffer: Buffer.from('<p></p>'),
            contentType: 'text/html'
          }
        ]
      })
    ).resolves.toEqual({
      cid: 'QmRoot',
      url: 'ipfs://QmRoot',
      files: { 'index.html': 'ipfs://QmRoot/index.html' }
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ipfs-api.example.test/api/v0/add?pin=true&wrap-with-directory=true',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it.each([
    ['/custom/add?pin=true&wrap-with-directory=true', '/custom/add?pin=true'],
    [
      '/custom/add?wrap-with-directory=true&pin=true&cid-version=1',
      '/custom/add?pin=true&cid-version=1'
    ],
    ['/custom/add?wrap-with-directory=true', '/custom/add'],
    ['/custom/add', '/custom/add']
  ])(
    'derives the single-file path from IPFS_API_UPLOAD_PATH %s',
    async (configuredPath, expectedPath) => {
      process.env.IPFS_API_UPLOAD_PATH = configuredPath;
      respond('{"Name":"pfp.png","Hash":"QmSingleFile"}');

      await new IpfsFileUploader().uploadFile({
        fileName: 'pfp.png',
        fileBuffer: Buffer.from('png'),
        contentType: 'image/png'
      });

      expect(fetchMock).toHaveBeenCalledWith(
        `https://ipfs-api.example.test${expectedPath}`,
        expect.objectContaining({ method: 'POST' })
      );
    }
  );

  it('reports a failed upload with its status', async () => {
    respond('rate limited', 503);

    await expect(
      new IpfsFileUploader().uploadFile({
        fileName: 'pfp.png',
        fileBuffer: Buffer.from('png'),
        contentType: 'image/png'
      })
    ).rejects.toThrow('IPFS upload failed with status 503: rate limited');
  });

  it('requires a configured endpoint', async () => {
    delete process.env.IPFS_API_ENDPOINT;

    await expect(
      new IpfsFileUploader().uploadFile({
        fileName: 'pfp.png',
        fileBuffer: Buffer.from('png'),
        contentType: 'image/png'
      })
    ).rejects.toThrow('IPFS_API_ENDPOINT not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
