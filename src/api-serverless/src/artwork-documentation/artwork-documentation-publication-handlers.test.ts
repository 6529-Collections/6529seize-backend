import { randomUUID } from 'node:crypto';
import { AuthenticationContext } from '@/auth-context';

const mockGetAuthenticationContext = jest.fn();
const mockPublish = jest.fn();
const mockList = jest.fn();
const mockWithdraw = jest.fn();

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
  writeAssetLink: jest.fn()
}));
jest.mock(
  '@/artwork-documentation/museum/publication/publication.service',
  () => ({
    artworkPublicationService: {
      publish: mockPublish,
      list: mockList,
      withdraw: mockWithdraw
    }
  })
);

import {
  handleCreateArtworkPublication,
  handleListArtworkPublications,
  handleWithdrawArtworkPublication
} from './artwork-documentation-publication.handlers';

describe('artwork publication handlers', () => {
  const contextId = randomUUID();
  const publicationId = randomUUID();
  const key = randomUUID();
  const authenticationContext =
    AuthenticationContext.fromProfileId(randomUUID());
  const summary = {
    id: publicationId,
    context_id: contextId,
    version: 1,
    state: 'published'
  };
  const body = {
    source_sha256: 'a'.repeat(64),
    selection: { asset_ids: [randomUUID()] },
    bindings: { base_url: 'https://6529.io/iiif/objects/x', media: {} },
    rights: {
      rights_uri: 'https://creativecommons.org/publicdomain/zero/1.0/',
      required_statement: { label: 'Credit', value: 'Artist' }
    },
    roles: {}
  };

  function request(
    method: string,
    path: string,
    headers: Record<string, string | undefined>,
    input?: unknown
  ) {
    return {
      params: { id: contextId, publicationId },
      body: input,
      method,
      path,
      get: (header: string) => headers[header],
      res: { set: jest.fn() }
    } as unknown as Parameters<typeof handleCreateArtworkPublication>[0];
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockPublish.mockResolvedValue(summary);
    mockList.mockResolvedValue([summary]);
    mockWithdraw.mockResolvedValue({ ...summary, state: 'withdrawn' });
  });

  it('publishes with the idempotency key, draft version and authenticated context, keeping responses private', async () => {
    const req = request(
      'POST',
      `/api/artwork-documentation/contexts/${contextId}/publications`,
      { 'Idempotency-Key': key, 'If-Match': '"draft-3"' },
      body
    );
    await expect(handleCreateArtworkPublication(req)).resolves.toEqual(summary);
    expect(mockPublish).toHaveBeenCalledWith(
      contextId,
      body,
      { key, route: `POST:${req.path}`, body, expectedVersion: 3 },
      { authenticationContext, timer: undefined }
    );
    expect(req.res?.set).toHaveBeenCalledWith(
      expect.objectContaining({ 'Cache-Control': 'private, no-store' })
    );
  });

  it('requires an idempotency key and a draft version before reaching the service', async () => {
    await expect(
      handleCreateArtworkPublication(
        request('POST', '/p', { 'If-Match': '"draft-1"' }, body)
      )
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    await expect(
      handleCreateArtworkPublication(
        request('POST', '/p', { 'Idempotency-Key': key }, body)
      )
    ).rejects.toMatchObject({ code: 'VERSION_REQUIRED' });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('lists publications for the authenticated actor', async () => {
    const req = request(
      'GET',
      `/api/artwork-documentation/contexts/${contextId}/publications`,
      {}
    );
    await expect(handleListArtworkPublications(req as never)).resolves.toEqual([
      summary
    ]);
    expect(mockList).toHaveBeenCalledWith(contextId, {
      authenticationContext,
      timer: undefined
    });
  });

  it('withdraws with an idempotency key but without a draft version', async () => {
    const req = request(
      'POST',
      `/api/artwork-documentation/contexts/${contextId}/publications/${publicationId}/withdraw`,
      { 'Idempotency-Key': key }
    );
    await expect(
      handleWithdrawArtworkPublication(req as never)
    ).resolves.toMatchObject({ state: 'withdrawn' });
    expect(mockWithdraw).toHaveBeenCalledWith(
      contextId,
      publicationId,
      {
        key,
        route: `POST:${req.path}`,
        body: null,
        expectedVersion: undefined
      },
      { authenticationContext, timer: undefined }
    );
  });

  it('rejects unsafe path identifiers before the service', async () => {
    const req = request('GET', '/p', {});
    (req.params as unknown as Record<string, string>).id = '';
    await expect(
      handleListArtworkPublications(req as never)
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(mockList).not.toHaveBeenCalled();
  });
});
