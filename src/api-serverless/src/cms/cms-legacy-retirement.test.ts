import { AuthenticationContext } from '@/auth-context';
import { CustomApiCompliantException } from '@/exceptions';
import { CmsApiService } from './cms.api.service';
import { cmsDb } from './cms.db';

function writer() {
  return {
    authenticationContext: new AuthenticationContext({
      authenticatedWallet: '0x0000000000000000000000000000000000000001',
      authenticatedProfileId: 'test-profile-1',
      roleProfileId: null,
      activeProxyActions: []
    })
  };
}

function service(features: { frozen: boolean; chain: boolean }) {
  return new CmsApiService({
    isIdentityFreezeOn: () => features.frozen,
    isProfileCmsChainPointerEnabled: () => features.chain
  });
}

async function refusal(
  promise: Promise<unknown>
): Promise<CustomApiCompliantException> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(CustomApiCompliantException);
  return error as CustomApiCompliantException;
}

describe('legacy CMS writes', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    [
      'are refused during the identity freeze',
      { frozen: true, chain: false },
      423,
      'IDENTITY_FROZEN'
    ],
    [
      'are retired once profile sites follow the chain, after the freeze',
      { frozen: false, chain: true },
      410,
      'cms_legacy_retired'
    ],
    [
      'are retired rather than frozen when the freeze is still on at the switch',
      { frozen: true, chain: true },
      410,
      'cms_legacy_retired'
    ]
  ])('%s', async (_name, features, status, code) => {
    const lookup = jest.spyOn(cmsDb, 'findSiteByOwnerAndSlug');
    const instance = service(features);
    for (const call of [
      () =>
        instance.createSite(
          { slug: 'a', title: 'A' } as never,
          writer() as never
        ),
      () => instance.publishPackage('site-a', {} as never, writer() as never)
    ]) {
      const error = await refusal(call());
      expect(error.getStatusCode()).toBe(status);
      expect(error.code).toBe(code);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('keep the old path with both flags off', async () => {
    jest.spyOn(cmsDb, 'findSiteByOwnerAndSlug').mockResolvedValue(null);
    jest.spyOn(cmsDb, 'countSitesByOwner').mockResolvedValue(0);
    const create = jest.spyOn(cmsDb, 'createSite').mockResolvedValue();
    await service({ frozen: false, chain: false }).createSite(
      { slug: 'a', title: 'A' } as never,
      writer() as never
    );
    expect(create).toHaveBeenCalled();
  });
});
