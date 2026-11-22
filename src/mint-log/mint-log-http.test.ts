jest.mock('@/api/auth/auth', () => ({
  getAuthenticatedWalletOrNull: jest.fn()
}));

import { getAuthenticatedWalletOrNull } from '@/api/auth/auth';
import {
  adminWriteSpec,
  intentBody,
  MINT_ADMIN_ROUTES,
  routeParams,
  SIGNED_RECORDS_HEADER
} from './mint-log-http';

describe('mint log admin requests', () => {
  it('takes the path parameters the route names, as strings', () => {
    expect(
      routeParams(MINT_ADMIN_ROUTES.distPhase, {
        contract: '0xABC',
        token_id: '100',
        allowlist_id: 'a1',
        phase_id: 'p1',
        extra: 'ignored'
      })
    ).toEqual({
      contract: '0xABC',
      token_id: '100',
      allowlist_id: 'a1',
      phase_id: 'p1'
    });
    expect(routeParams(MINT_ADMIN_ROUTES.claimAction, {})).toEqual({
      contract: '',
      claim_id: ''
    });
  });

  it('builds the write spec from the request', () => {
    (getAuthenticatedWalletOrNull as jest.Mock).mockReturnValue(
      '0x00000000000000000000000000000000000000AA'
    );
    const headers: Record<string, string> = {
      [SIGNED_RECORDS_HEADER]: 'header-value'
    };
    const req = {
      params: { contract: '0xABC', id: '7' },
      get: (name: string) => headers[name]
    } as any;
    const spec = adminWriteSpec({
      req,
      kind: 'dist.normalize',
      route: MINT_ADMIN_ROUTES.distNormalize,
      card: { contract: '0xabc', card_id: 7 },
      authority: 'env:DISTRIBUTION_ADMIN_WALLETS',
      body: {}
    });
    expect(spec).toMatchObject({
      kind: 'dist.normalize',
      card: { contract: '0xabc', card_id: 7 },
      actor: {
        type: 'admin',
        wallet: '0x00000000000000000000000000000000000000aa',
        authority: 'env:DISTRIBUTION_ADMIN_WALLETS'
      },
      intent: {
        route: 'POST /distributions/:contract/:id/normalize',
        params: { contract: '0xABC', id: '7' },
        body: null
      },
      signedRecords: 'header-value'
    });
  });

  it('counts a missing body and an empty object as no body', () => {
    expect(intentBody(undefined)).toBeNull();
    expect(intentBody(null)).toBeNull();
    expect(intentBody({})).toBeNull();
    expect(intentBody([])).toEqual([]);
    expect(intentBody({ csv: 'x' })).toEqual({ csv: 'x' });
  });

  it('has no record header when the request carries none', () => {
    (getAuthenticatedWalletOrNull as jest.Mock).mockReturnValue(null);
    const spec = adminWriteSpec({
      req: { params: {}, get: () => undefined } as any,
      kind: 'claim.action',
      route: MINT_ADMIN_ROUTES.claimAction,
      card: { contract: '0xabc', card_id: 1 },
      authority: 'env:CLAIMS_ADMIN_WALLETS',
      body: { action: 'PAY_ARTIST', completed: true }
    });
    expect(spec.signedRecords).toBeNull();
    expect(spec.actor.wallet).toBeNull();
  });
});
