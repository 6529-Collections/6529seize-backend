import { AuthenticationContext } from '@/auth-context';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '@/exceptions';
import { ApiCmsPublishPackageRequest } from '@/api/generated/models/ApiCmsPublishPackageRequest';
import { CmsApiService } from './cms.api.service';
import { cmsDb, CmsPublishedSiteRow, CmsSiteRow } from './cms.db';
import { getCmsPackageHash, hashCmsJson } from './cms.hashing';

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

function cmsPayload() {
  return {
    schema: '6529.cms.payload.v1',
    site: {
      id: 'site-1',
      slug: 'home',
      title: 'Collected Signals',
      description: 'Gallery',
      owner_profile: {
        id: 'profile-6529',
        handle: 'punk6529',
        display_name: 'punk6529',
        path: '/punk6529'
      },
      theme: {
        mode: 'dark',
        accent_color: '#9df871'
      }
    },
    page: {
      id: 'home',
      title: 'Collected Signals',
      description: 'Gallery',
      slug_path: '',
      static_export_path: '/punk6529/index.html',
      canonical_url: 'https://6529.io/punk6529/index.html',
      page_type: 'gallery',
      social: {
        title: 'Collected Signals',
        description: 'Gallery',
        canonical_url: 'https://6529.io/punk6529/index.html',
        open_graph_image: {
          url: '/memes-preview.png',
          width: 1200,
          height: 630,
          alt: 'Preview'
        }
      },
      created_at: '2026-06-16T00:00:00.000Z',
      updated_at: '2026-06-16T00:00:00.000Z'
    },
    assets: [],
    blocks: [
      {
        id: 'heading',
        type: 'heading',
        level: 2,
        text: 'Collected Signals'
      }
    ],
    provenance: {
      source: 'fixture',
      builder_version: 'cms-studio-v0'
    }
  };
}

function cmsStorage() {
  return [
    {
      provider: 'ipfs',
      uri: 'ipfs://bafyexample',
      pinned: true
    }
  ];
}

function cmsSignature() {
  return {
    signature_type: 'fixture',
    signing_wallet: '0x0000000000000000000000000000000000006529',
    signed_at: '2026-06-16T00:00:00.000Z',
    signature: '0xsignature'
  };
}

function cmsPackageJson() {
  const payload = cmsPayload();
  const storage = cmsStorage();
  const signature = cmsSignature();
  const payload_hash = hashCmsJson(payload);
  const packageWithoutHash = {
    schema: '6529.cms.package.v1',
    payload_hash,
    package_hash: null,
    payload,
    signature,
    storage
  };

  return {
    ...packageWithoutHash,
    package_hash: getCmsPackageHash(packageWithoutHash)
  };
}

function publishRequest(
  overrides: Partial<ApiCmsPublishPackageRequest> = {}
): ApiCmsPublishPackageRequest {
  const packageJson = cmsPackageJson();
  return {
    package_hash: packageJson.package_hash,
    payload_hash: packageJson.payload_hash,
    schema: '6529.cms.package.v1',
    title: 'Collected Signals',
    description: null,
    static_path: '/punk6529/index.html',
    canonical_url: 'https://6529.io/punk6529/index.html',
    package_json: packageJson,
    storage: packageJson.storage,
    signature: packageJson.signature,
    set_primary: true,
    ...overrides
  };
}

function publishedSiteRow(): CmsPublishedSiteRow {
  const request = publishRequest();
  return {
    site: siteRow({
      primary_package_hash: request.package_hash,
      primary_static_path: '/punk6529/index.html'
    }),
    published_package: {
      package_hash: request.package_hash,
      payload_hash: request.payload_hash,
      schema: '6529.cms.package.v1',
      site_id: 'site-1',
      owner_profile_id: 'profile-6529',
      title: 'Collected Signals',
      description: null,
      static_path: '/punk6529/index.html',
      canonical_url: 'https://6529.io/punk6529/index.html',
      package_json: request.package_json,
      storage_json: request.storage,
      signature_json: request.signature,
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

  it('rejects payload hash mismatches before publishing', async () => {
    jest.spyOn(cmsDb, 'findSiteById').mockResolvedValue(siteRow());
    const publishPackage = jest
      .spyOn(cmsDb, 'publishPackage')
      .mockResolvedValue();

    await expect(
      service.publishPackage(
        'site-1',
        publishRequest({
          payload_hash: payloadHash
        }),
        authContext()
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(publishPackage).not.toHaveBeenCalled();
  });

  it('rejects package hash mismatches before publishing', async () => {
    jest.spyOn(cmsDb, 'findSiteById').mockResolvedValue(siteRow());
    const publishPackage = jest
      .spyOn(cmsDb, 'publishPackage')
      .mockResolvedValue();

    await expect(
      service.publishPackage(
        'site-1',
        publishRequest({
          package_hash: packageHash
        }),
        authContext()
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(publishPackage).not.toHaveBeenCalled();
  });

  it('rejects unknown sites before publishing', async () => {
    jest.spyOn(cmsDb, 'findSiteById').mockResolvedValue(null);
    const publishPackage = jest
      .spyOn(cmsDb, 'publishPackage')
      .mockResolvedValue();

    await expect(
      service.publishPackage('site-missing', publishRequest(), authContext())
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(publishPackage).not.toHaveBeenCalled();
  });

  it('rejects non-owner publishing before primary pointer changes', async () => {
    jest.spyOn(cmsDb, 'findSiteById').mockResolvedValue(
      siteRow({
        owner_profile_id: 'profile-other'
      })
    );
    const publishPackage = jest
      .spyOn(cmsDb, 'publishPackage')
      .mockResolvedValue();

    await expect(
      service.publishPackage('site-1', publishRequest(), authContext())
    ).rejects.toBeInstanceOf(ForbiddenException);
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
        package_hash: publishRequest().package_hash,
        payload_hash: publishRequest().payload_hash,
        site_id: 'site-1',
        owner_profile_id: 'profile-6529',
        static_path: '/punk6529/index.html',
        published_by_wallet: '0x0000000000000000000000000000000000006529'
      }),
      true
    );
    expect(response.published_package.package_hash).toBe(
      publishRequest().package_hash
    );
    expect(response.site.primary_static_path).toBe('/punk6529/index.html');
  });

  it('publishes a duplicate package hash for the same site idempotently', async () => {
    jest.spyOn(cmsDb, 'findSiteById').mockResolvedValue(siteRow());
    jest
      .spyOn(cmsDb, 'findPublishedPackageByHash')
      .mockResolvedValue(publishedSiteRow().published_package);
    jest.spyOn(cmsDb, 'publishPackage').mockResolvedValue();
    jest
      .spyOn(cmsDb, 'findPrimaryPublishedSiteByOwnerProfileId')
      .mockResolvedValue(publishedSiteRow());

    await service.publishPackage('site-1', publishRequest(), authContext());

    expect(cmsDb.publishPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        package_hash: publishRequest().package_hash,
        site_id: 'site-1'
      }),
      true
    );
  });
});
