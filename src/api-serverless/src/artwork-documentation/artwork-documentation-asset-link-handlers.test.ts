import { randomUUID } from 'node:crypto';
import { AuthenticationContext } from '@/auth-context';

const mockGetAuthenticationContext = jest.fn();
const mockWriteAssetLink = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));
jest.mock('@/artwork-documentation/artwork-documentation.service', () => ({
  artworkDocumentationService: {}
}));
jest.mock('@/artwork-documentation/artwork-documentation.review', () => ({
  artworkDocumentationReviewService: {}
}));
jest.mock('@/artwork-documentation/assets/artwork-assets.service', () => ({
  artworkAssetsService: {}
}));
jest.mock('@/artwork-documentation/artwork-documentation.asset-links', () => ({
  writeAssetLink: mockWriteAssetLink
}));

import {
  handleLinkDocumentationAsset,
  handlePatchDocumentationAssetLink
} from './artwork-documentation-assets.handlers';

describe.each([
  ['POST', handleLinkDocumentationAsset],
  ['PATCH', handlePatchDocumentationAssetLink]
] as const)('%s documentation asset links', (method, handler) => {
  const contextId = randomUUID();
  const linkId = randomUUID();
  const assetId = randomUUID();
  const key = randomUUID();
  const authenticationContext =
    AuthenticationContext.fromProfileId(randomUUID());

  function request(input: Record<string, unknown>) {
    return {
      params: { id: contextId, linkId },
      body: input,
      method,
      path: `/api/artwork-documentation/contexts/${contextId}/asset-links`,
      get: (header: string) =>
        header === 'Idempotency-Key' ? key : '"draft-1"',
      res: { set: jest.fn() }
    } as unknown as Parameters<typeof handlePatchDocumentationAssetLink>[0];
  }

  function payload(extra: Record<string, unknown> = {}) {
    return {
      asset_id: assetId,
      role: 'artwork_final',
      intended_visibility: 'public_record',
      intended_terms: { kind: 'private_deposit' },
      ...extra
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockWriteAssetLink.mockResolvedValue({ id: contextId, draft_version: 2 });
  });

  it.each([
    ['omitted', {}],
    ['empty', { derived_from_asset_ids: [] }],
    ['populated', { derived_from_asset_ids: [randomUUID()] }]
  ])('accepts an %s derivation list', async (_label, extra) => {
    const input = payload(extra);
    const req = request(input);
    await expect(handler(req)).resolves.toEqual({
      id: contextId,
      draft_version: 2
    });
    expect(mockWriteAssetLink.mock.calls[0].slice(0, 4)).toEqual([
      contextId,
      input,
      {
        key,
        route: `${method}:${req.path}`,
        body: input,
        expectedVersion: 1
      },
      { authenticationContext, timer: undefined }
    ]);
    expect(req.res?.set).toHaveBeenCalledWith('ETag', '"draft-2"');
    if (method === 'PATCH')
      expect(mockWriteAssetLink.mock.calls[0][4]).toBe(linkId);
  });

  it.each([
    ['invalid UUID', { derived_from_asset_ids: ['not-a-uuid'] }],
    ['null entry', { derived_from_asset_ids: [null] }],
    ['non-array value', { derived_from_asset_ids: assetId }],
    ['over-limit list', { derived_from_asset_ids: Array(31).fill(assetId) }]
  ])('rejects an %s before the write boundary', async (_label, extra) => {
    await expect(handler(request(payload(extra)))).rejects.toMatchObject({
      code: 'INVALID_REQUEST'
    });
    expect(mockWriteAssetLink).not.toHaveBeenCalled();
  });

  it('requires an asset ID before the write boundary', async () => {
    const input: Record<string, unknown> = payload();
    delete input.asset_id;
    await expect(handler(request(input))).rejects.toMatchObject({
      code: 'INVALID_REQUEST'
    });
    expect(mockWriteAssetLink).not.toHaveBeenCalled();
  });
});
