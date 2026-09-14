import {
  ApiProposalFrameRequest,
  ApiProposalFrameRequestLayoutEnum as Layout,
  ApiProposalFrameRequestMimeTypeEnum as Mime
} from '@/api/generated/models/ApiProposalFrameRequest';
import { CLOUDFRONT_LINK } from '@/constants';
import { DropMediaUploadStatus } from '@/entities/IDropMediaUpload';
import { ProposalFrameService } from '@/proposal-card/proposal-frame.service';

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const PROFILE = '32d48691-d056-459f-a9a4-9a7c885c4449';
const SOURCE = `${CLOUDFRONT_LINK}/drops/author_${PROFILE}/art/pepe.png`;

describe('ProposalFrameService', () => {
  const uploadDirectory = jest.fn();
  const findByPublicUrl = jest.fn();
  const service = new ProposalFrameService(
    { uploadDirectory },
    { findByPublicUrl }
  );
  const request = (
    overrides: Partial<ApiProposalFrameRequest> = {}
  ): ApiProposalFrameRequest => ({
    media_url: SOURCE,
    mime_type: Mime.ImagePng,
    title: 'Permanent Pepe',
    layout: Layout.Portrait,
    ...overrides
  });
  const publishedHtml = (): string =>
    uploadDirectory.mock.calls[0][0].files[0].fileBuffer.toString('utf8');

  beforeEach(() => {
    jest.clearAllMocks();
    findByPublicUrl.mockResolvedValue(null);
    uploadDirectory.mockResolvedValue({
      files: { 'index.html': `ipfs://${CID}/index.html` }
    });
  });

  it('publishes a bounded HTML document with the uploaded image and returns drop-ready media', async () => {
    await expect(service.publish(request(), PROFILE)).resolves.toEqual({
      url: `ipfs://${CID}/index.html`,
      mime_type: 'text/html'
    });
    expect(uploadDirectory).toHaveBeenCalledTimes(1);
    const files = uploadDirectory.mock.calls[0][0].files;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      fileName: 'index.html',
      contentType: 'text/html'
    });
    expect(files[0].fileBuffer.length).toBeLessThan(32768);
    expect(publishedHtml()).toContain(`<img src="${SOURCE}"`);
    expect(publishedHtml()).toContain('aspect-ratio:5 / 7');
  });

  it('preserves video playback controls inside the horizontal frame', async () => {
    await service.publish(
      request({
        media_url: SOURCE.replace('.png', '.mp4'),
        mime_type: Mime.VideoMp4,
        layout: Layout.Landscape
      }),
      PROFILE
    );
    expect(publishedHtml()).toContain('<video ');
    expect(publishedHtml()).toContain('controls playsinline');
    expect(publishedHtml()).toContain('aspect-ratio:7 / 5');
  });

  it.each([
    `ipfs://${CID}/art/index.html`,
    `https://ipfs.io/ipfs/${CID}/art/index.html`
  ])(
    'canonicalizes decentralized HTML and confines its scripts: %s',
    async (media_url) => {
      await service.publish(
        request({ media_url, mime_type: Mime.TextHtml }),
        PROFILE
      );
      expect(publishedHtml()).toContain(
        `src="https://media.6529.io/ipfs/${CID}/art/index.html"`
      );
      expect(publishedHtml()).toContain('sandbox="allow-scripts"');
      expect(publishedHtml()).not.toContain('allow-same-origin');
      expect(publishedHtml()).not.toContain('allow-top-navigation');
      expect(findByPublicUrl).not.toHaveBeenCalled();
    }
  );

  it('supports existing decentralized photos without fetching the source', async () => {
    await service.publish(
      request({ media_url: `ipfs://${CID}/pepe.png` }),
      PROFILE
    );
    expect(publishedHtml()).toContain(
      `src="https://media.6529.io/ipfs/${CID}/pepe.png"`
    );
    expect(findByPublicUrl).not.toHaveBeenCalled();
  });

  it('escapes caller text in the HTML title and media attributes', async () => {
    await service.publish(
      request({ title: '</title><script>alert("x")</script>' }),
      PROFILE
    );
    expect(publishedHtml()).toContain(
      '&lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
    );
    expect(publishedHtml()).not.toContain('<script>alert(');
  });

  it.each([
    'https://attacker.example/pepe.png',
    'http://localhost/pepe.png',
    'file:///etc/passwd',
    'data:text/html;base64,PHNjcmlwdD4=',
    `https://user:secret@ipfs.io/ipfs/${CID}/index.html`,
    SOURCE.replace(`/author_${PROFILE}/`, '/author_someone-else/'),
    `${SOURCE}?untracked=true`,
    `${SOURCE}#ignored`,
    `${SOURCE}\n`
  ])(
    'rejects an unsafe or unowned source before publishing: %s',
    async (media_url) => {
      await expect(
        service.publish(request({ media_url }), PROFILE)
      ).rejects.toThrow();
      expect(uploadDirectory).not.toHaveBeenCalled();
    }
  );

  it('rejects HTML from the upload CDN', async () => {
    await expect(
      service.publish(
        request({
          media_url: SOURCE.replace('.png', '.html'),
          mime_type: Mime.TextHtml
        }),
        PROFILE
      )
    ).rejects.toThrow('HTML artwork must be served');
    expect(uploadDirectory).not.toHaveBeenCalled();
  });

  it('rejects arbitrary client HTML and bounded-input violations', async () => {
    const invalidRequests = [
      { ...request(), html: '<script>bad()</script>' },
      request({ title: 'x'.repeat(251) }),
      request({ media_url: `https://ipfs.io/ipfs/${CID}/${'x'.repeat(2048)}` }),
      { ...request(), layout: 'square' },
      { ...request(), mime_type: 'image/svg+xml' }
    ];
    for (const input of invalidRequests) {
      await expect(
        service.publish(input as ApiProposalFrameRequest, PROFILE)
      ).rejects.toThrow();
    }
    expect(uploadDirectory).not.toHaveBeenCalled();
  });

  it('prevents declaring executable uploads as photos', async () => {
    await expect(
      service.publish(
        request({ media_url: SOURCE.replace('.png', '.html') }),
        PROFILE
      )
    ).rejects.toThrow('filename does not match');
    expect(uploadDirectory).not.toHaveBeenCalled();
  });

  it.each([
    DropMediaUploadStatus.UPLOADING,
    DropMediaUploadStatus.PROCESSING,
    DropMediaUploadStatus.SANITIZING,
    DropMediaUploadStatus.FAILED
  ])('does not wrap images before sanitizer success: %s', async (status) => {
    findByPublicUrl.mockResolvedValue({
      profile_id: PROFILE,
      status,
      declared_mime_type: Mime.ImagePng
    });
    await expect(service.publish(request(), PROFILE)).rejects.toThrow(
      'Wait for artwork processing'
    );
    expect(uploadDirectory).not.toHaveBeenCalled();
  });

  it('accepts a ready, owned sanitized upload', async () => {
    findByPublicUrl.mockResolvedValue({
      profile_id: PROFILE,
      status: DropMediaUploadStatus.READY,
      declared_mime_type: Mime.ImagePng
    });
    await service.publish(request(), PROFILE);
    expect(uploadDirectory).toHaveBeenCalledTimes(1);
  });

  it('rejects tracked MIME and owner mismatches', async () => {
    findByPublicUrl.mockResolvedValue({
      profile_id: 'other',
      status: DropMediaUploadStatus.READY,
      declared_mime_type: Mime.ImagePng
    });
    await expect(service.publish(request(), PROFILE)).rejects.toThrow(
      'Use artwork uploaded by your profile'
    );
    findByPublicUrl.mockResolvedValue({
      profile_id: PROFILE,
      status: DropMediaUploadStatus.READY,
      declared_mime_type: Mime.ImageJpeg
    });
    await expect(service.publish(request(), PROFILE)).rejects.toThrow(
      'MIME type does not match'
    );
    expect(uploadDirectory).not.toHaveBeenCalled();
  });

  it('fails the request when IPFS publication fails', async () => {
    uploadDirectory.mockRejectedValue(new Error('IPFS unavailable'));
    await expect(service.publish(request(), PROFILE)).rejects.toThrow(
      'IPFS unavailable'
    );
  });
});
