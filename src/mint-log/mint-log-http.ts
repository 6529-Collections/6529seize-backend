import type { Request } from 'express';
import { getAuthenticatedWalletOrNull } from '@/api/auth/auth';
import type { MintWriteSpec } from './mint-log-recorder';
export { mintCard } from './mint-log-parts';
import type { MintCardRef, MintLogKind } from './mint-log.types';

/**
 * The admin routes whose writes the mint log records. The frontend signs the
 * same route strings (`lib/mint-records` there), so change both together.
 */
export const MINT_ADMIN_ROUTES = {
  distPhase:
    'GET /subscriptions/allowlists/:contract/:token_id/:allowlist_id/:phase_id',
  distReset:
    'POST /subscriptions/allowlists/:contract/:token_id/:allowlist_id/reset',
  distNormalize: 'POST /distributions/:contract/:id/normalize',
  distArtistAirdrops: 'POST /distributions/:contract/:id/artist-airdrops',
  distTeamAirdrops: 'POST /distributions/:contract/:id/team-airdrops',
  distGithubUpload: 'POST /distributions/:contract/:id/github-upload',
  distPhotos: 'POST /distribution_photos/:contract/:nft_id/complete',
  claimEdit: 'PATCH /minting-claims/:contract/claims/:claim_id',
  claimMediaRequest:
    'POST /minting-claims/:contract/claims/:claim_id/arweave-upload',
  claimAction: 'POST /minting-claims/actions/:contract/:claim_id'
} as const;

export type MintAdminRoute =
  (typeof MINT_ADMIN_ROUTES)[keyof typeof MINT_ADMIN_ROUTES];

export const SIGNED_RECORDS_HEADER = 'x-6529-signed-records';

export const MINT_AUTHORITY = {
  distributionAdmins: 'env:DISTRIBUTION_ADMIN_WALLETS',
  claimsAdmins: 'env:CLAIMS_ADMIN_WALLETS',
  memesContractAdmin: 'ethereum:memes-contract-isAdmin',
  nextgenAdmin: 'ethereum:nextgen-admin'
} as const;

/** The route's path parameters as sent, by the names in its pattern. */
export function routeParams(
  route: MintAdminRoute,
  params: Record<string, string | undefined>
): Record<string, string> {
  const names = route
    .split(' ')[1]
    .split('/')
    .filter((segment) => segment.startsWith(':'))
    .map((segment) => segment.slice(1));
  const picked: Record<string, string> = {};
  for (const name of names) {
    picked[name] = String(params[name] ?? '');
  }
  return picked;
}

/**
 * The request body an admin signs: the JSON body as sent, with a missing body
 * and an empty object both counting as null (clients and body parsers differ
 * on which of the two an empty POST becomes).
 */
export function intentBody(body: unknown): unknown {
  if (body === undefined || body === null) return null;
  if (
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body as object).length === 0
  ) {
    return null;
  }
  return body;
}

/** The write spec of an admin request; the record type is `mint.admin`. */
export function adminWriteSpec<T = unknown>(args: {
  readonly req: Request<any, any, any, any, any>;
  readonly kind: MintLogKind;
  readonly route: MintAdminRoute;
  readonly card: MintCardRef;
  readonly authority: string;
  /** The request body as received (`req.body`); null for a GET. */
  readonly body: unknown;
  readonly inputs?: MintWriteSpec<T>['inputs'];
  readonly outputs?: MintWriteSpec<T>['outputs'];
}): MintWriteSpec<T> {
  const wallet = getAuthenticatedWalletOrNull(args.req);
  return {
    kind: args.kind,
    card: args.card,
    actor: {
      type: 'admin',
      wallet: wallet ? wallet.toLowerCase() : null,
      authority: args.authority
    },
    intent: {
      route: args.route,
      params: routeParams(args.route, args.req.params ?? {}),
      body: intentBody(args.body)
    },
    signedRecords: args.req.get?.(SIGNED_RECORDS_HEADER) ?? null,
    inputs: args.inputs,
    outputs: args.outputs
  };
}
