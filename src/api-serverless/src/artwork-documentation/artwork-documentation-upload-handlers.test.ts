import { randomUUID } from 'node:crypto';
import { AuthenticationContext } from '@/auth-context';
import { emptyCapabilities } from '@/artwork-documentation/artwork-documentation.access';
import { programViewerCapabilities } from '@/artwork-documentation/artwork-documentation.program-viewers';
import { ContextAccess } from '@/artwork-documentation/artwork-documentation.types';
import { fail } from '@/artwork-documentation/artwork-documentation.validation';

const mockGetAuthenticationContext = jest.fn();
const mockCore = {
  authorizeContext: jest.fn(),
  authorizeMutationContext: jest.fn(),
  mutationCapabilities: jest.fn(),
  bindAssetMutation: jest.fn(),
  setAssetGateway: jest.fn()
};
const mockAssets = {
  startUpload: jest.fn(),
  getUpload: jest.fn(),
  signParts: jest.fn(),
  completeUpload: jest.fn(),
  cancelUpload: jest.fn(),
  download: jest.fn()
};
jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));
jest.mock('@/artwork-documentation/artwork-documentation.service', () => ({
  artworkDocumentationService: mockCore
}));
jest.mock('@/artwork-documentation/artwork-documentation.review', () => ({
  artworkDocumentationReviewService: {}
}));
jest.mock('@/artwork-documentation/assets/artwork-assets.service', () => ({
  artworkAssetsService: mockAssets
}));

import {
  handleStartDocumentationUpload,
  handleGetDocumentationUpload,
  handleSignDocumentationParts,
  handleCompleteDocumentationUpload,
  handleCancelDocumentationUpload,
  handleDownloadDocumentationAsset
} from './artwork-documentation-assets.handlers';

describe('documentation upload authorization boundary', () => {
  const actor = randomUUID();
  const contextId = randomUUID();
  const uploadId = randomUUID();
  const key = randomUUID();
  const original = {
    ...emptyCapabilities(),
    read_context: true,
    edit_modules: ['files'] as ContextAccess['capabilities']['edit_modules']
  };
  const readAccess = {
    actorProfileId: actor,
    isArtist: false,
    context: { id: contextId, lifecycle: 'active', profile: {}, modules: {} },
    capabilities: {
      ...programViewerCapabilities(),
      edit_modules: original.edit_modules
    }
  } as ContextAccess;
  function request<T>(body: unknown = {}): T {
    return {
      params: { id: contextId, uploadId, assetId: uploadId },
      body,
      method: 'POST',
      path: `/api/artwork-documentation/contexts/${contextId}/uploads/${uploadId}`,
      get: () => key,
      res: { set: jest.fn() }
    } as unknown as T;
  }
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthenticationContext.mockResolvedValue(
      AuthenticationContext.fromProfileId(actor)
    );
    mockCore.authorizeContext.mockResolvedValue(readAccess);
    mockCore.authorizeMutationContext.mockResolvedValue({
      ...readAccess,
      capabilities: original
    });
    mockCore.mutationCapabilities.mockResolvedValue(original);
  });
  it('passes original writer scope to every upload mutation', async () => {
    await handleStartDocumentationUpload(
      request({
        filename: 'work.png',
        size_bytes: 9,
        declared_mime: 'image/png',
        role: 'artwork_final',
        intended_visibility: 'public_record'
      })
    );
    const part = {
      part_number: 1,
      checksum_sha256: Buffer.alloc(32).toString('base64')
    };
    await handleSignDocumentationParts(request({ parts: [part] }));
    await handleCompleteDocumentationUpload(
      request({ parts: [{ ...part, etag: 'etag' }] })
    );
    await handleCancelDocumentationUpload(request());
    for (const [call, index] of [
      [mockAssets.startUpload, 1],
      [mockAssets.signParts, 2],
      [mockAssets.completeUpload, 2],
      [mockAssets.cancelUpload, 2]
    ] as const) {
      expect(call.mock.calls[0][index]).toMatchObject({
        canEdit: true,
        canReadArchivalFiles: false,
        canReadRightsEvidence: false
      });
    }
    expect(mockCore.authorizeMutationContext).toHaveBeenCalledTimes(4);
    expect(mockCore.authorizeContext).not.toHaveBeenCalled();
  });
  it('keeps metadata and downloads readable while upload mutation scope stays separate', async () => {
    await handleGetDocumentationUpload(request());
    expect(mockAssets.getUpload.mock.calls[0][2]).toMatchObject({
      canReadArchivalFiles: true,
      canReadRightsEvidence: true
    });
    expect(mockAssets.getUpload.mock.calls[0][3]).toMatchObject({
      canReadArchivalFiles: false,
      canReadRightsEvidence: false
    });
    await handleDownloadDocumentationAsset(request({ variant: 'original' }));
    expect(mockAssets.download.mock.calls[0][2]).toMatchObject({
      canReadArchivalFiles: true,
      canReadRightsEvidence: true
    });
    expect(mockCore.authorizeMutationContext).not.toHaveBeenCalled();
  });
  it('rejects a reader before any upload storage operation', async () => {
    mockCore.authorizeMutationContext.mockImplementation(() =>
      fail(403, 'EDIT_NOT_ALLOWED')
    );
    await expect(handleSignDocumentationParts(request())).rejects.toMatchObject(
      { code: 'EDIT_NOT_ALLOWED' }
    );
    expect(mockAssets.signParts).not.toHaveBeenCalled();
  });
  it('accepts the full 8 GiB upload and 512-part completion at the HTTP boundary', async () => {
    const upload = {
      filename: 'preservation.tiff',
      size_bytes: 8 * 1024 ** 3,
      declared_mime: 'image/tiff',
      role: 'preservation_master',
      intended_visibility: 'public_record'
    };
    await handleStartDocumentationUpload(request(upload));
    expect(mockAssets.startUpload).toHaveBeenCalledTimes(1);
    await expect(
      handleStartDocumentationUpload(
        request({ ...upload, size_bytes: upload.size_bytes + 1 })
      )
    ).rejects.toBeDefined();
    expect(mockAssets.startUpload).toHaveBeenCalledTimes(1);
    const parts = Array.from({ length: 512 }, (_, index) => ({
      part_number: index + 1,
      checksum_sha256: Buffer.alloc(32).toString('base64'),
      etag: `part-${index + 1}`
    }));
    await handleSignDocumentationParts(
      request({
        parts: [
          { part_number: 512, checksum_sha256: parts[511].checksum_sha256 }
        ]
      })
    );
    await handleCompleteDocumentationUpload(request({ parts }));
    expect(mockAssets.completeUpload).toHaveBeenCalledTimes(1);
    await expect(
      handleCompleteDocumentationUpload(
        request({ parts: [...parts, { ...parts[0], part_number: 513 }] })
      )
    ).rejects.toBeDefined();
    expect(mockAssets.completeUpload).toHaveBeenCalledTimes(1);
  });
});
