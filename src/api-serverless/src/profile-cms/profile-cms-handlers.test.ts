import { AuthenticationContext } from '@/auth-context';
import { ApiCmsValidationResult } from '@/api/generated/models/ApiCmsValidationResult';
import { ApiProfileCmsPackage } from '@/api/generated/models/ApiProfileCmsPackage';
import { ApiProfileCmsPrimaryPackage } from '@/api/generated/models/ApiProfileCmsPrimaryPackage';
import {
  ArchiveProfileCmsPackageRequest,
  ExportProfileCmsPackageRequest,
  GetProfileCmsPackageByVersionRequest,
  GetPrimaryProfileCmsPackageRequest,
  RollbackProfileCmsPackageRequest,
  SaveProfileCmsPackageDraftRequest,
  ValidateProfileCmsPackageRequest
} from '@/api/generated/routes/operations';
import { NotFoundException } from '@/exceptions';
import {
  createValidProfileCmsPackage,
  PROFILE_CMS_FIXTURE_HANDLE,
  PROFILE_CMS_FIXTURE_PROFILE_ID
} from '@/tests/fixtures/profile-cms-package.fixture';

const mockGetAuthenticationContext = jest.fn();
const mockProfileCmsApiService = {
  saveDraft: jest.fn(),
  validatePackage: jest.fn(),
  getPrimaryByHandle: jest.fn(),
  getByVersion: jest.fn(),
  rollbackPrimary: jest.fn(),
  archivePackage: jest.fn(),
  exportPackage: jest.fn()
};

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/profile-cms/profile-cms.api.service', () => ({
  profileCmsApiService: mockProfileCmsApiService
}));

import {
  handleArchiveProfileCmsPackage,
  handleExportProfileCmsPackage,
  handleGetProfileCmsPackageByVersion,
  handleGetPrimaryProfileCmsPackage,
  handleRollbackProfileCmsPackage,
  handleSaveProfileCmsPackageDraft,
  handleValidateProfileCmsPackage
} from './profile-cms.handlers';

describe('profile CMS handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('saves a draft through the API handler with authentication context', async () => {
    const authenticationContext = AuthenticationContext.fromProfileId(
      PROFILE_CMS_FIXTURE_PROFILE_ID
    );
    const cmsPackage = createValidProfileCmsPackage();
    const apiPackage = {
      id: 'cms-package-id',
      package: cmsPackage,
      profile_id: PROFILE_CMS_FIXTURE_PROFILE_ID,
      profile_handle: PROFILE_CMS_FIXTURE_HANDLE,
      package_id: cmsPackage.package_id,
      version: 1,
      status: 'draft',
      package_hash: cmsPackage.integrity.package_hash,
      payload_hash: cmsPackage.integrity.payload_hash,
      updated_at: 1000,
      created_at: 1000
    } as unknown as ApiProfileCmsPackage;
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockProfileCmsApiService.saveDraft.mockResolvedValue(apiPackage);

    const request = {
      body: {
        profile_id: PROFILE_CMS_FIXTURE_PROFILE_ID,
        cms_package: cmsPackage
      },
      params: {},
      query: {}
    } as unknown as SaveProfileCmsPackageDraftRequest;

    await expect(handleSaveProfileCmsPackageDraft(request)).resolves.toBe(
      apiPackage
    );
    expect(mockProfileCmsApiService.saveDraft).toHaveBeenCalledWith(
      request.body,
      { authenticationContext, timer: undefined }
    );
  });

  it('validates a CMS package through the API handler', async () => {
    const validation = {
      schema: '6529.cms.validation_result.v1',
      valid: true,
      checked_at: '2026-06-17T00:00:00.000Z',
      issues: []
    } as ApiCmsValidationResult;
    mockProfileCmsApiService.validatePackage.mockReturnValue(validation);
    const request = {
      body: {
        cms_package: createValidProfileCmsPackage(),
        enforce_hashes: true
      },
      params: {},
      query: {}
    } as unknown as ValidateProfileCmsPackageRequest;

    await expect(handleValidateProfileCmsPackage(request)).resolves.toBe(
      validation
    );
  });

  it('returns the public primary package envelope and propagates 404 when absent', async () => {
    const cmsPackage = createValidProfileCmsPackage();
    const primary = {
      package: cmsPackage,
      package_id: cmsPackage.package_id,
      version: 1,
      package_hash: cmsPackage.integrity.package_hash,
      payload_hash: cmsPackage.integrity.payload_hash,
      updated_at: 1000,
      published_at: 1000
    } as unknown as ApiProfileCmsPrimaryPackage;
    mockProfileCmsApiService.getPrimaryByHandle.mockResolvedValueOnce(primary);

    const request = {
      params: { handle: PROFILE_CMS_FIXTURE_HANDLE },
      body: undefined,
      query: {}
    } as unknown as GetPrimaryProfileCmsPackageRequest;

    await expect(handleGetPrimaryProfileCmsPackage(request)).resolves.toBe(
      primary
    );

    mockProfileCmsApiService.getPrimaryByHandle.mockRejectedValueOnce(
      new NotFoundException('missing primary')
    );
    await expect(
      handleGetPrimaryProfileCmsPackage(request)
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('coerces version path params before package version lookup', async () => {
    const authenticationContext = AuthenticationContext.fromProfileId(
      PROFILE_CMS_FIXTURE_PROFILE_ID
    );
    const cmsPackage = createValidProfileCmsPackage();
    const apiPackage = {
      id: 'cms-package-id',
      package: cmsPackage,
      profile_id: PROFILE_CMS_FIXTURE_PROFILE_ID,
      profile_handle: PROFILE_CMS_FIXTURE_HANDLE,
      package_id: cmsPackage.package_id,
      version: 2,
      status: 'published',
      package_hash: cmsPackage.integrity.package_hash,
      payload_hash: cmsPackage.integrity.payload_hash,
      updated_at: 1000,
      created_at: 1000,
      published_at: 1000
    } as unknown as ApiProfileCmsPackage;
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockProfileCmsApiService.getByVersion.mockResolvedValue(apiPackage);

    const request = {
      params: {
        profile_id: PROFILE_CMS_FIXTURE_PROFILE_ID,
        package_id: cmsPackage.package_id,
        version: '2'
      },
      body: undefined,
      query: {}
    } as unknown as GetProfileCmsPackageByVersionRequest;

    await expect(handleGetProfileCmsPackageByVersion(request)).resolves.toBe(
      apiPackage
    );
    expect(mockProfileCmsApiService.getByVersion).toHaveBeenCalledWith(
      PROFILE_CMS_FIXTURE_PROFILE_ID,
      cmsPackage.package_id,
      2,
      { authenticationContext, timer: undefined }
    );
  });

  it('rolls back through the API handler with current-package guard', async () => {
    const authenticationContext = AuthenticationContext.fromProfileId(
      PROFILE_CMS_FIXTURE_PROFILE_ID
    );
    const cmsPackage = createValidProfileCmsPackage();
    const apiPackage = {
      id: 'previous-package',
      package: cmsPackage,
      profile_id: PROFILE_CMS_FIXTURE_PROFILE_ID,
      profile_handle: PROFILE_CMS_FIXTURE_HANDLE,
      package_id: cmsPackage.package_id,
      version: 1,
      status: 'published',
      package_hash: cmsPackage.integrity.package_hash,
      payload_hash: cmsPackage.integrity.payload_hash,
      updated_at: 1000,
      created_at: 1000,
      published_at: 1000
    } as unknown as ApiProfileCmsPackage;
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockProfileCmsApiService.rollbackPrimary.mockResolvedValue(apiPackage);

    const request = {
      params: { id: 'previous-package' },
      body: { expected_current_package_id: 'current-package' },
      query: {}
    } as unknown as RollbackProfileCmsPackageRequest;

    await expect(handleRollbackProfileCmsPackage(request)).resolves.toBe(
      apiPackage
    );
    expect(mockProfileCmsApiService.rollbackPrimary).toHaveBeenCalledWith(
      'previous-package',
      request.body,
      { authenticationContext, timer: undefined }
    );
  });

  it('archives through the API handler', async () => {
    const authenticationContext = AuthenticationContext.fromProfileId(
      PROFILE_CMS_FIXTURE_PROFILE_ID
    );
    const cmsPackage = createValidProfileCmsPackage();
    const apiPackage = {
      id: 'cms-package-id',
      package: cmsPackage,
      profile_id: PROFILE_CMS_FIXTURE_PROFILE_ID,
      profile_handle: PROFILE_CMS_FIXTURE_HANDLE,
      package_id: cmsPackage.package_id,
      version: 1,
      status: 'archived',
      package_hash: cmsPackage.integrity.package_hash,
      payload_hash: cmsPackage.integrity.payload_hash,
      updated_at: 1000,
      created_at: 1000
    } as unknown as ApiProfileCmsPackage;
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockProfileCmsApiService.archivePackage.mockResolvedValue(apiPackage);

    const request = {
      params: { id: 'cms-package-id' },
      body: { expected_package_hash: cmsPackage.integrity.package_hash },
      query: {}
    } as unknown as ArchiveProfileCmsPackageRequest;

    await expect(handleArchiveProfileCmsPackage(request)).resolves.toBe(
      apiPackage
    );
  });

  it('exports through the API handler', async () => {
    const authenticationContext = AuthenticationContext.fromProfileId(
      PROFILE_CMS_FIXTURE_PROFILE_ID
    );
    const cmsPackage = createValidProfileCmsPackage();
    const exported = {
      package: cmsPackage,
      package_id: cmsPackage.package_id,
      package_db_id: 'cms-package-id',
      version: 1,
      status: 'published',
      profile_id: PROFILE_CMS_FIXTURE_PROFILE_ID,
      profile_handle: PROFILE_CMS_FIXTURE_HANDLE,
      primary_path: `/${PROFILE_CMS_FIXTURE_HANDLE}/index.html`,
      package_hash: cmsPackage.integrity.package_hash,
      payload_hash: cmsPackage.integrity.payload_hash,
      storage_receipts: cmsPackage.storage,
      pointer_events: [],
      updated_at: 1000,
      published_at: 1000
    };
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockProfileCmsApiService.exportPackage.mockResolvedValue(exported);

    const request = {
      params: { id: 'cms-package-id' },
      body: undefined,
      query: {}
    } as unknown as ExportProfileCmsPackageRequest;

    await expect(handleExportProfileCmsPackage(request)).resolves.toBe(
      exported
    );
  });
});
