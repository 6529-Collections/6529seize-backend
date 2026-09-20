import { randomUUID } from 'node:crypto';
import { applyOperations } from '@/artwork-documentation/artwork-documentation.catalogue';
import { ApiCompliantException } from '@/exceptions';
import { Logger } from '@/logging';

const mockCore = { patchModule: jest.fn(), setAssetGateway: jest.fn() };
const mockAuthentication = jest.fn().mockResolvedValue({});
jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockAuthentication
}));
jest.mock('@/artwork-documentation/artwork-documentation.service', () => ({
  artworkDocumentationService: mockCore
}));
jest.mock('@/artwork-documentation/artwork-documentation.review', () => ({
  artworkDocumentationReviewService: {}
}));
jest.mock('@/artwork-documentation/assets/artwork-assets.service', () => ({
  artworkAssetsService: {}
}));

import { handlePatchDocumentationModule } from './artwork-documentation.handlers';

function request(
  body: unknown
): Parameters<typeof handlePatchDocumentationModule>[0] {
  const id = randomUUID();
  const key = randomUUID();
  return {
    params: { id, moduleId: 'artwork' },
    body,
    method: 'PATCH',
    path: `/api/artwork-documentation/contexts/${id}/modules/artwork`,
    get: (name: string) => (name === 'If-Match' ? '"draft-1"' : key),
    res: { set: jest.fn() }
  } as unknown as Parameters<typeof handlePatchDocumentationModule>[0];
}

describe('module PATCH rejection logging boundary', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    warn = jest
      .spyOn(Logger.get('ARTWORK_DOCUMENTATION_VALIDATION'), 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('logs the original failure once before clearing input and rethrows the same error', async () => {
    const operations = [
      {
        op: 'set' as const,
        field: 'declared_dimensions',
        answer: {
          status: 'provided' as const,
          value: { width: 0, height: 200 },
          intended_visibility: 'public_record' as const
        }
      }
    ];
    let failure: unknown;
    try {
      applyOperations('artwork', {}, operations);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ApiCompliantException);
    mockCore.patchModule.mockRejectedValue(failure);
    const req = request({ schema_version: 1, operations });
    await expect(handlePatchDocumentationModule(req)).rejects.toBe(failure);
    expect(req.body).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
      code: 'INVALID_VALUE',
      operation_fields: [{ operation: 'set', field: 'declared_dimensions' }],
      rejected_field: { module: 'artwork', field: 'declared_dimensions' }
    });
  });

  it('also identifies HTTP shape validation without passing untrusted field names to logs', async () => {
    const req = request({
      schema_version: 1,
      operations: [
        { op: 'set', field: 'PRIVATE_FILENAME', extra: 'PRIVATE_ANSWER' }
      ]
    });
    await expect(handlePatchDocumentationModule(req)).rejects.toMatchObject({
      code: 'INVALID_REQUEST'
    });
    expect(mockCore.patchModule).not.toHaveBeenCalled();
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
      code: 'INVALID_REQUEST',
      operation_fields: []
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_');
  });

  it('does not add diagnostic entries for a successful patch', async () => {
    mockCore.patchModule.mockResolvedValue({ draft_version: 2 });
    const req = request({
      schema_version: 1,
      operations: [{ op: 'set', field: 'title', answer: {} }]
    });
    await expect(handlePatchDocumentationModule(req)).resolves.toEqual({
      draft_version: 2
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
