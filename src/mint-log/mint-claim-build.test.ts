import {
  buildClaimLogged,
  parseChainClaimContext,
  verifyChainClaim
} from './mint-claim-build';
import type { MintChainDecisionResult, MintGatewayPort } from './mint-gateway';

const id = (c: string) => '0x' + c.repeat(64);

const chain = {
  decision_id: id('d'),
  occurrence: 3,
  entry_id: id('e'),
  height: 1200,
  manifest_hash: id('f')
};

function gateway(result: MintChainDecisionResult | null): MintGatewayPort {
  return { decisionResult: jest.fn().mockResolvedValue(result) };
}

const final: MintChainDecisionResult = {
  decision_id: chain.decision_id,
  occurrence: 3,
  state: 'FINAL',
  height: 1300,
  winners: [
    { rank: 2, entry_id: id('a'), manifest_hash: id('b') },
    { rank: 1, entry_id: chain.entry_id, manifest_hash: chain.manifest_hash }
  ]
};

describe('chain claim context', () => {
  it('parses a valid context', () => {
    expect(parseChainClaimContext({ ...chain, extra: 1 })).toEqual(chain);
  });

  it.each([
    ['a short decision id', { decision_id: '0x12' }],
    ['an upper-case entry id', { entry_id: '0x' + 'E'.repeat(64) }],
    ['a negative occurrence', { occurrence: -1 }],
    ['a zero height', { height: 0 }],
    ['a missing manifest hash', { manifest_hash: undefined }]
  ])('refuses %s', (_label, change) => {
    expect(() => parseChainClaimContext({ ...chain, ...change })).toThrow(
      'Invalid chain claim context'
    );
  });

  const listed = [chain.decision_id];

  it('refuses a decision that is not on the Main Stage list', async () => {
    await expect(verifyChainClaim(chain, gateway(final), [])).rejects.toThrow(
      /not in MAIN_STAGE_DECISION_IDS/
    );
  });

  it('refuses to build without a gateway to check the result', async () => {
    await expect(verifyChainClaim(chain, null, listed)).rejects.toThrow(
      'No gateway is bound'
    );
  });

  it('is verified when the final result put this entry first', async () => {
    const port = gateway(final);
    await expect(verifyChainClaim(chain, port, listed)).resolves.toBe(
      'verified'
    );
    expect(port.decisionResult).toHaveBeenCalledWith(chain.decision_id, 3);
  });

  it.each([
    ['no result', null],
    ['a pending result', { ...final, state: 'PENDING' as const }],
    [
      'another winner',
      {
        ...final,
        winners: [{ rank: 1, entry_id: id('a'), manifest_hash: id('f') }]
      }
    ],
    [
      'another manifest',
      {
        ...final,
        winners: [{ rank: 1, entry_id: chain.entry_id, manifest_hash: id('a') }]
      }
    ]
  ])('throws on %s', async (_label, result) => {
    await expect(
      verifyChainClaim(chain, gateway(result), listed)
    ).rejects.toThrow(/did not pick/);
  });
});

describe('buildClaimLogged', () => {
  it('logs the build as a service write on the claim id it takes', async () => {
    const write = jest.fn(async (_spec: any, run: () => Promise<unknown>) =>
      run()
    );
    const claims = {
      claimIdForDrop: jest.fn().mockResolvedValue(512),
      createClaimForDropIfMissing: jest.fn().mockResolvedValue(undefined)
    };
    await buildClaimLogged(
      { dropId: 'drop-1', chain },
      {
        recorder: { write } as any,
        claims: claims as any,
        gateway: gateway(final),
        mainStage: [chain.decision_id]
      }
    );
    const spec = write.mock.calls[0][0];
    expect(spec).toMatchObject({
      kind: 'claim.built',
      actor: { type: 'service', wallet: null, authority: 'main-stage-result' },
      intent: {
        route: 'SQS claims-builder',
        params: { drop_id: 'drop-1' },
        body: { competition: null, chain }
      }
    });
    await expect(spec.card({ connection: 'tx' })).resolves.toEqual({
      contract: '0x33fd426905f149f8376e227d0c9d3340aad17af1',
      card_id: 512
    });
    expect(claims.claimIdForDrop).toHaveBeenCalledWith('drop-1', {
      connection: { connection: 'tx' }
    });
    await expect(spec.inputs()).resolves.toEqual({
      chain_result: { ...chain, check: 'verified' }
    });
    expect(claims.createClaimForDropIfMissing).toHaveBeenCalledWith(
      'drop-1',
      undefined
    );
  });

  it('does not build a claim the chain did not pick', async () => {
    const write = jest.fn();
    await expect(
      buildClaimLogged(
        { dropId: 'drop-1', chain },
        {
          recorder: { write } as any,
          claims: {} as any,
          gateway: gateway(null),
          mainStage: [chain.decision_id]
        }
      )
    ).rejects.toThrow(/did not pick/);
    expect(write).not.toHaveBeenCalled();
  });
});
