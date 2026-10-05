import type { Request, Response } from 'express';
import { asyncRouter } from '@/api/async.router';
import { assertMintingClaimActionAccess } from '@/api/minting-claims/minting-claim-actions.authorization';
import { fetchMintingClaimByClaimId } from '@/api/minting-claims/api.minting-claims.db';
import {
  getMintingClaimActionsResponse,
  getMintingClaimActionTypesResponse,
  upsertMintingClaimActionAndGetResponse
} from '@/api/minting-claims/minting-claim-actions.api.service';
import { MEMES_CONTRACT } from '@/constants';
import { ForbiddenException } from '@/exceptions';

jest.mock('@/api/async.router', () => ({
  asyncRouter: jest.fn(() => ({ get: jest.fn(), post: jest.fn() }))
}));
jest.mock('@/api/auth/auth', () => ({
  needsAuthenticatedUser: jest.fn(() => jest.fn()),
  getAuthenticatedWalletOrNull: jest.fn(
    () => '0x0000000000000000000000000000000000000123'
  ),
  getWalletOrThrow: jest.fn(() => '0x0000000000000000000000000000000000000123')
}));
jest.mock('@/api/minting-claims/minting-claim-actions.authorization', () => ({
  assertMintingClaimActionAccess: jest.fn()
}));
jest.mock('@/api/minting-claims/api.minting-claims.db', () => ({
  fetchMintingClaimByClaimId: jest.fn()
}));
jest.mock('@/api/minting-claims/minting-claim-actions.api.service', () => ({
  assertSupportedMintingClaimAction: jest.fn(),
  getMintingClaimActionTypesResponse: jest.fn(),
  getMintingClaimActionsResponse: jest.fn(),
  getSupportedMintingClaimActionTypesOrThrow: jest.fn(),
  upsertMintingClaimActionAndGetResponse: jest.fn()
}));
jest.mock('@/time', () => ({ Timer: { getFromRequest: jest.fn(() => ({})) } }));
import '@/api/minting-claims/api.minting-claims.actions.routes';

const router = jest.mocked(asyncRouter).mock.results[0].value;
const routes = {
  get: [...router.get.mock.calls],
  post: [...router.post.mock.calls]
};
const cases = [
  ['get', '/:contract/types'],
  ['get', '/:contract/:claim_id'],
  ['post', '/:contract/:claim_id']
] as const;
function invoke(method: 'get' | 'post', path: string) {
  const route = routes[method].find((args: unknown[]) => args[0] === path);
  if (!route) throw new Error('Missing route');
  const response = { json: jest.fn() };
  const handler = route.at(-1);
  return {
    response,
    promise: handler(
      {
        params: path.endsWith('types')
          ? { contract: MEMES_CONTRACT }
          : { contract: MEMES_CONTRACT, claim_id: '42' },
        body: { action: 'initialize_claim', completed: true }
      } as unknown as Request,
      response as unknown as Response
    )
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(assertMintingClaimActionAccess).mockResolvedValue(undefined);
  jest
    .mocked(fetchMintingClaimByClaimId)
    .mockResolvedValue({ claim_id: 42 } as NonNullable<
      Awaited<ReturnType<typeof fetchMintingClaimByClaimId>>
    >);
});

it.each(cases)(
  'checks authenticated creator access for %s %s',
  async (method, path) => {
    const { promise } = invoke(method, path);
    await promise;
    expect(assertMintingClaimActionAccess).toHaveBeenCalledWith(
      '0x0000000000000000000000000000000000000123',
      MEMES_CONTRACT
    );
    if (method === 'post')
      expect(upsertMintingClaimActionAndGetResponse).toHaveBeenCalled();
    else if (path.endsWith('types'))
      expect(getMintingClaimActionTypesResponse).toHaveBeenCalled();
    else expect(getMintingClaimActionsResponse).toHaveBeenCalled();
  }
);

it.each(cases)(
  'rejects %s %s before reading or changing claim state',
  async (method, path) => {
    jest
      .mocked(assertMintingClaimActionAccess)
      .mockRejectedValue(new ForbiddenException('Denied'));
    await expect(invoke(method, path).promise).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(fetchMintingClaimByClaimId).not.toHaveBeenCalled();
    expect(getMintingClaimActionTypesResponse).not.toHaveBeenCalled();
    expect(getMintingClaimActionsResponse).not.toHaveBeenCalled();
    expect(upsertMintingClaimActionAndGetResponse).not.toHaveBeenCalled();
  }
);
