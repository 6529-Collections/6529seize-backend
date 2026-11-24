jest.mock('@/api/identities/identity.fetcher', () => ({
  identityFetcher: {},
  IdentityFetcher: jest.fn()
}));

import { ProfileCmsApiService } from '@/api/profile-cms/profile-cms.api.service';
import { CustomApiCompliantException } from '@/exceptions';
import { RequestContext } from '@/request.context';

function service(features: { frozen: boolean; chain: boolean }) {
  const packagesDb = { findById: jest.fn(), findByIdForUpdate: jest.fn() };
  const instance = new ProfileCmsApiService(
    packagesDb as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    jest.fn(),
    undefined,
    {} as never,
    {
      isIdentityFreezeOn: () => features.frozen,
      isProfileCmsChainPointerEnabled: () => features.chain
    }
  );
  return { instance, packagesDb };
}

const ctx: RequestContext = { timer: undefined };
const guard = { expected_current_package_id: 'draft-1' };

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

describe('profile site pointer moves on 6529.io', () => {
  it('are all refused during the identity freeze, before any read', async () => {
    const { instance, packagesDb } = service({ frozen: true, chain: false });
    for (const call of [
      () => instance.publish('draft-1', guard as never, ctx),
      () => instance.rollbackPrimary('draft-1', guard as never, ctx),
      () => instance.unpublishPackage('draft-1', guard as never, ctx),
      () => instance.archivePackage('draft-1', {} as never, ctx)
    ]) {
      const error = await refusal(call());
      expect(error.getStatusCode()).toBe(423);
      expect(error.code).toBe('IDENTITY_FROZEN');
    }
    expect(packagesDb.findById).not.toHaveBeenCalled();
  });

  it('follow the chain flag when freeze settings are left on after the switch', async () => {
    const { instance, packagesDb } = service({ frozen: true, chain: true });
    const error = await refusal(
      instance.unpublishPackage('draft-1', guard as never, ctx)
    );
    expect(error.getStatusCode()).toBe(409);
    expect(error.code).toBe('cms_pointer_on_chain');
    packagesDb.findById.mockResolvedValue(null);
    // Rollback reads its target to check it before the chain move.
    for (const call of [
      () => instance.publish('draft-1', guard as never, ctx),
      () => instance.rollbackPrimary('draft-1', guard as never, ctx),
      () => instance.archivePackage('draft-1', {} as never, ctx)
    ]) {
      await expect(call()).rejects.not.toBeInstanceOf(
        CustomApiCompliantException
      );
    }
    expect(packagesDb.findById).toHaveBeenCalledTimes(3);
  });

  it('send unpublish to the chain once profile sites follow it, before any read', async () => {
    const { instance, packagesDb } = service({ frozen: false, chain: true });
    const error = await refusal(
      instance.unpublishPackage('draft-1', guard as never, ctx)
    );
    expect(error.getStatusCode()).toBe(409);
    expect(error.code).toBe('cms_pointer_on_chain');
    expect(packagesDb.findById).not.toHaveBeenCalled();
  });

  it('let publish and archive go on once profile sites follow the chain', async () => {
    const { instance, packagesDb } = service({ frozen: false, chain: true });
    packagesDb.findById.mockResolvedValue(null);
    await expect(
      instance.publish('draft-1', guard as never, ctx)
    ).rejects.not.toBeInstanceOf(CustomApiCompliantException);
    await expect(
      instance.archivePackage('draft-1', {} as never, ctx)
    ).rejects.not.toBeInstanceOf(CustomApiCompliantException);
    expect(packagesDb.findById).toHaveBeenCalledTimes(2);
  });

  it('go through to the old path with both flags off', async () => {
    const { instance, packagesDb } = service({ frozen: false, chain: false });
    packagesDb.findById.mockResolvedValue(null);
    await expect(
      instance.rollbackPrimary('draft-1', guard as never, ctx)
    ).rejects.not.toBeInstanceOf(CustomApiCompliantException);
    expect(packagesDb.findById).toHaveBeenCalled();
  });
});
