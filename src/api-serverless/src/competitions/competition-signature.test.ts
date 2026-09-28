import { randomUUID } from 'node:crypto';
import { Wallet } from 'ethers';
import * as fc from 'fast-check';
import { AuthenticationContext } from '@/auth-context';
import {
  canonicalCompetitionJson,
  competitionPayloadHash
} from '@/competitions/competition-command-identity';
import { competitionCommandRepository } from '@/competitions/competition-command.repository';
import {
  CompetitionSigningAction,
  verifyCompetitionSignature
} from './competition-signature';

const originalApiBaseUrl = process.env.API_BASE_URL;
const wallet = Wallet.createRandom();
const actor = 'effective-profile';
const now = 1900000000000;
const context = {
  authenticationContext: new AuthenticationContext({
    authenticatedWallet: wallet.address,
    authenticatedProfileId: actor,
    roleProfileId: null,
    activeProxyActions: []
  })
};
const action: CompetitionSigningAction = {
  action: 'VOTE_SET',
  wave_id: 'hub',
  competition_id: randomUUID(),
  competition_entry_id: randomUUID(),
  drop_id: 'drop',
  config_version: 3,
  payload: { value: -7 }
};

async function signed(overrides: Record<string, unknown> = {}) {
  const { payload, ...identity } = action;
  const message = canonicalCompetitionJson({
    domain: '6529-competition-v1',
    audience: 'api.6529.io',
    chain_id: 1,
    ...identity,
    actor_profile_id: actor,
    actor_wallet: wallet.address.toLowerCase(),
    payload_hash: competitionPayloadHash(payload),
    nonce: randomUUID(),
    issued_at: now,
    expires_at: now + 300000,
    ...overrides
  });
  return { message, signature: await wallet.signMessage(message) };
}

describe('Native competition signature binding', () => {
  beforeEach(() => {
    process.env.API_BASE_URL = 'https://api.6529.io/api';
    jest
      .spyOn(competitionCommandRepository, 'consumeNonce')
      .mockResolvedValue(undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalApiBaseUrl === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = originalApiBaseUrl;
  });

  it('accepts an EOA signature and consumes its scoped nonce', async () => {
    const signature = await signed();
    await expect(
      verifyCompetitionSignature(action, signature, true, now, context)
    ).resolves.toBeUndefined();
    expect(competitionCommandRepository.consumeNonce).toHaveBeenCalledWith(
      action.competition_id,
      actor,
      'VOTE_SET',
      JSON.parse(signature.message).nonce,
      context
    );
  });

  it.each([
    'domain',
    'audience',
    'chain_id',
    'action',
    'wave_id',
    'competition_id',
    'competition_entry_id',
    'drop_id',
    'actor_profile_id',
    'actor_wallet',
    'payload_hash',
    'config_version'
  ])('rejects changed %s even when cryptographically signed', async (field) => {
    await expect(
      verifyCompetitionSignature(
        action,
        await signed({ [field]: 'different' }),
        true,
        now,
        context
      )
    ).rejects.toThrow('Invalid competition signature');
    expect(competitionCommandRepository.consumeNonce).not.toHaveBeenCalled();
  });

  it('rejects a valid signature from a different API deployment', async () => {
    const signature = await signed();
    process.env.API_BASE_URL = 'https://api.staging.6529.io/api';
    await expect(
      verifyCompetitionSignature(action, signature, true, now, context)
    ).rejects.toThrow('Invalid competition signature');
    expect(competitionCommandRepository.consumeNonce).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    'http://api.6529.io',
    'https://user:password@api.6529.io'
  ])(
    'fails closed when the API deployment audience is unconfigured or invalid (%s)',
    async (baseUrl) => {
      if (baseUrl === undefined) delete process.env.API_BASE_URL;
      else process.env.API_BASE_URL = baseUrl;
      await expect(
        verifyCompetitionSignature(action, await signed(), true, now, context)
      ).rejects.toThrow('API_BASE_URL');
      expect(competitionCommandRepository.consumeNonce).not.toHaveBeenCalled();
    }
  );

  it.each([
    { issued_at: now + 1 },
    { expires_at: now },
    { expires_at: now + 300001 },
    { nonce: 'not-a-nonce' }
  ])('rejects an invalid lifetime or nonce', async (override) => {
    await expect(
      verifyCompetitionSignature(
        action,
        await signed(override),
        true,
        now,
        context
      )
    ).rejects.toThrow('Expired or invalid');
  });

  it('requires a signature only when configured, but validates an optional supplied signature', async () => {
    await expect(
      verifyCompetitionSignature(action, undefined, false, now, context)
    ).resolves.toBeUndefined();
    await expect(
      verifyCompetitionSignature(action, undefined, true, now, context)
    ).rejects.toThrow('requires a signature');
    await expect(
      verifyCompetitionSignature(
        action,
        await signed({ extra: true }),
        false,
        now,
        context
      )
    ).rejects.toThrow('Invalid competition signature');
  });

  it('canonical hashes ignore object key ordering but preserve array order', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (first, second) => {
        expect(competitionPayloadHash({ b: second, a: first })).toBe(
          competitionPayloadHash({ a: first, b: second })
        );
      })
    );
    expect(competitionPayloadHash([1, 2])).not.toBe(
      competitionPayloadHash([2, 1])
    );
  });
});
