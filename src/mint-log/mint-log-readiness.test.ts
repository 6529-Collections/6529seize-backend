import { setMintGateway, setMintPrincipalBindings } from './mint-gateway';
import {
  describeMintLogReadiness,
  mintLogReadiness
} from './mint-log-readiness';

const flags = (shadow: boolean, primary: boolean) => ({
  isMintLogShadowEnabled: () => shadow,
  isMintLogPrimaryEnabled: () => primary
});

describe('mint log readiness at start', () => {
  beforeEach(() => {
    setMintPrincipalBindings(null);
    setMintGateway(null);
  });

  it('says what primary mode refuses while nothing is bound', () => {
    const readiness = mintLogReadiness(flags(true, true), []);
    expect(describeMintLogReadiness(readiness)).toBe(
      '[MINT_LOG] [MODE primary] [RECORD VERIFIER unbound] [GATEWAY unbound] [NOT READY] ' +
        'PRIMARY is on but no principal bindings are bound: admin minting writes from the site are refused ' +
        '(400 INVALID_SIGNED_RECORD without a record, 503 with one); NextGen uploads and service writes go on'
    );
  });

  it('reports a Main Stage list with no gateway to check it', () => {
    const readiness = mintLogReadiness(flags(false, false), ['0xdecision']);
    expect(readiness.problems).toEqual([
      'MAIN_STAGE_DECISION_IDS is set but no gateway is bound: chain claim messages are refused'
    ]);
  });

  it('reports nothing when off with no list', () => {
    expect(
      describeMintLogReadiness(mintLogReadiness(flags(false, false), []))
    ).toBe('[MINT_LOG] [MODE off] [RECORD VERIFIER unbound] [GATEWAY unbound]');
  });
});
