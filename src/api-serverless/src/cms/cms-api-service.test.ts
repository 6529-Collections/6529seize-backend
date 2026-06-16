import { AuthenticationContext } from '@/auth-context';
import { BadRequestException } from '@/exceptions';
import { ApiCmsPublishPackageRequest } from '@/api/generated/models/ApiCmsPublishPackageRequest';
import { CmsApiService } from './cms.api.service';
import { cmsDb, CmsPublishedSiteRow, CmsSiteRow } from './cms.db';

function authContext() {
  return {
    authenticationContext: new AuthenticationContext({
      authenticatedWallet: '0x0000000000000000000000000000000000006529',
      authenticatedProfileId: 'profile-6529',
      roleProfileId: null,
      activeProxyActions: []
    })
  };
}

function siteRow(overrides: Partial<CmsSiteRow> = {}): CmsSiteRow {
  return {
    id: 'site-1',
    owner_profile_id: 'profile-6529',
    slug: 'home',
    title: 'Home',
    description: null,
    primary_package_hash: null,
    primary_static_path: null,
    created_at: 1,
    updated_at: 1,
    created_by_wallet: '0x0000000000000000000000000000000000006529',
    updated_by_wallet: null,
    ...overrides
  };
}

const packageHash =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const payloadHash =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function publishRequest(
  overrides: Partial<ApiCmsPublishPackageRequest> = {}
): ApiCmsPublishPackageRequest {
  return {
    package_hash: packageHash,
    payload_hash: payloadHash,
    schema: '6529.cms.package.v1',
    title: 'Collected Signals',
    description: null,
    static_path: '/punk6529/index.html',
    canonical_url: 'https://6529.io/punk6529/index.html',
    package_json: {
      schema: '6529.cms.package.v1'
    },
    storage: [
      {
        provider: 'ipfs',
        uri: 'ipfs://bafyexample',
        pinned: true
      }
    ],
    signature: {
      signature_type: 'eip191',
      signing_wallet: '0x0000000000000000000000000000000000006529',
      signed_at: '2026-06-16T00:00:00.000Z',
      signature: '0xsignature'
    },
    set_primary: true,
    ...overrides
  };
}

function publishedSiteRow(): CmsPublishedSiteRow {
  return {
    site: siteRow({
      primary_package_hash: packageHash,
      primary_static_path: '/punk6529/index.html'
    }),
    published_package: {
      package_hash: packageHash,
      payload_hash: payloadHash,
      schema: '6529.cms.package.v1',
      site_id: 'site-1',
      owner_profile_id: 'profile-6529',
      title: 'Collected Signals',
      description: null,
      static_path: '/punk6529/index.html',
      canonical_url: 'https://6529.io/punk6529/index.html',
      package_json: {
        schema: '6529.cms.package.v1'
      },
      storage_json: [
        {
          provider: 'ipfs',
          uri: 'ipfs://bafyexample',
          pinned: true
        }
      ],
      signature_json: {
        signature_type: 'eip191',
        signing_wallet: '0x0000000000000000000000000000000000006529',
        signed_at: '2026-06-16T00:00:00.000Z',
        signature: '0xsignature'
      },
      published_at: 2,
      published_by_wallet: '0x0000000000000000000000000000000000006529'
    }
  };
}

describe('CmsApiService', () => {
  const service = new CmsApiService();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates a profile-owned site with normalized slug', async () => {
    jest.spyOn(cmsDb, 'findSiteByOwnerAndSlug').mockResolvedValue(null);
    const createSite = jest.spyOn(cmsDb, 'createSite').mockResolvedValue();

    const response = await service.createSite(
      {
        slug: 'Gallery',
        title: 'Gallery',
        description: null
      },
      authContext()
    );

    expect(createSite).toHaveBeenCalledWith(
      expect.objectContaining({
        owner_profile_id: 'profile-6529',
        slug: 'gallery',
        title: 'Gallery',
        description: null,
        created_by_wallet: '0x0000000000000000000000000000000000006529'
      })
    );
    expect(response).toEqual(
      expect.objectContaining({
        owner_profile_id: 'profile-6529',
        slug: 'gallery',
        primary_package_hash: null
      })
    );
  });

  it('rejects package hashes already attached to another site', async () => {
    jest.spyOn(cmsDb, 'findSiteById').mockResolvedValue(siteRow());
    jest.spyOn(cmsDb, 'findPublishedPackageByHash').mockResolvedValue({
      ...publishedSiteRow().published_package,
      site_id: 'site-2'
    });
    const publishPackage = jest
      .spyOn(cmsDb, 'publishPackage')
      .mockResolvedValue();

    await expect(
      service.publishPackage('site-1', publishRequest(), authContext())
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(publishPackage).not.toHaveBeenCalled();
  });

  it('publishes a package and returns the updated primary site', async () => {
    jest.spyOn(cmsDb, 'findSiteById').mockResolvedValue(siteRow());
    jest.spyOn(cmsDb, 'findPublishedPackageByHash').mockResolvedValue(null);
    jest.spyOn(cmsDb, 'publishPackage').mockResolvedValue();
    jest
      .spyOn(cmsDb, 'findPrimaryPublishedSiteByOwnerProfileId')
      .mockResolvedValue(publishedSiteRow());

    const response = await service.publishPackage(
      'site-1',
      publishRequest(),
      authContext()
    );

    expect(cmsDb.publishPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        package_hash: packageHash,
        payload_hash: payloadHash,
        site_id: 'site-1',
        owner_profile_id: 'profile-6529',
        static_path: '/punk6529/index.html'
      }),
      true
    );
    expect(response.published_package.package_hash).toBe(packageHash);
    expect(response.site.primary_static_path).toBe('/punk6529/index.html');
  });
});
