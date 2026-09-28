import { ApiCompetitionSignature } from '@/api/generated/models/ApiCompetitionSignature';
import { verifyWalletMessageSignature } from '@/api/wallet-signatures/structured-wallet-signatures';
import {
  canonicalCompetitionJson,
  competitionPayloadHash
} from '@/competitions/competition-command-identity';
import { competitionCommandRepository } from '@/competitions/competition-command.repository';
import { ForbiddenException } from '@/exceptions';
import { RequestContext } from '@/request.context';

export type CompetitionSigningAction = {
  action: 'ENTRY_CREATE' | 'VOTE_SET';
  wave_id: string;
  competition_id: string;
  competition_entry_id: string | null;
  drop_id: string | null;
  config_version: number;
  payload: unknown;
};

function competitionSignatureAudience(): string {
  const configuredUrl = process.env.API_BASE_URL;
  if (!configuredUrl)
    throw new Error(
      'API_BASE_URL is required for native competition signatures'
    );
  const url = new URL(configuredUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
  ) {
    throw new Error('Invalid API_BASE_URL for native competition signatures');
  }
  return url.host.toLowerCase();
}

export async function verifyCompetitionSignature(
  action: CompetitionSigningAction,
  signature: ApiCompetitionSignature | undefined,
  required: boolean,
  now: number,
  ctx: RequestContext
): Promise<void> {
  if (!signature) {
    if (required)
      throw new ForbiddenException('This competition requires a signature');
    return;
  }
  const wallet = ctx.authenticationContext?.authenticatedWallet?.toLowerCase();
  const actor = ctx.authenticationContext?.getActingAsId();
  if (!wallet || !actor)
    throw new ForbiddenException(
      'A wallet-authenticated signature is required'
    );
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(signature.message) as Record<string, unknown>;
  } catch {
    throw new ForbiddenException('Invalid competition signature');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new ForbiddenException('Invalid competition signature');
  }
  const { issued_at: issuedAt, expires_at: expiresAt, nonce } = envelope;
  if (
    typeof issuedAt !== 'number' ||
    !Number.isSafeInteger(issuedAt) ||
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(expiresAt) ||
    issuedAt > now ||
    issuedAt < now - 300000 ||
    expiresAt <= now ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 300000 ||
    typeof nonce !== 'string' ||
    !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(
      nonce
    )
  )
    throw new ForbiddenException('Expired or invalid competition signature');
  const { payload, ...identity } = action;
  const expected = canonicalCompetitionJson({
    domain: '6529-competition-v1',
    audience: competitionSignatureAudience(),
    chain_id: 1,
    ...identity,
    actor_profile_id: actor,
    actor_wallet: wallet,
    payload_hash: competitionPayloadHash(payload),
    nonce,
    issued_at: issuedAt,
    expires_at: expiresAt
  });
  if (
    signature.message !== expected ||
    !(await verifyWalletMessageSignature({
      message: signature.message,
      signature: signature.signature,
      expectedAddress: wallet,
      chainId: 1
    }))
  )
    throw new ForbiddenException('Invalid competition signature');
  await competitionCommandRepository.consumeNonce(
    action.competition_id,
    actor,
    action.action,
    nonce,
    ctx
  );
}
