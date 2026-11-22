import { appFeatures, AppFeatures } from '@/app-features';
import { getMintGateway, getMintPrincipalBindings } from './mint-gateway';
import { mainStageDecisionIds } from './mint-claim-build';

export interface MintLogReadiness {
  readonly mode: 'off' | 'shadow' | 'primary';
  /** Signed records can be checked: the principal bindings are bound. */
  readonly recordVerifier: boolean;
  /** Chain claim results can be checked: the gateway is bound. */
  readonly gateway: boolean;
  /** What does not work with this configuration. */
  readonly problems: string[];
}

/**
 * What the mint log can do as configured. PRIMARY needs the principal
 * bindings from the signed-records module; until they are bound, PRIMARY
 * answers 503 to every admin minting write.
 */
export function mintLogReadiness(
  features: Pick<
    AppFeatures,
    'isMintLogShadowEnabled' | 'isMintLogPrimaryEnabled'
  > = appFeatures,
  decisionIds: readonly string[] = mainStageDecisionIds()
): MintLogReadiness {
  const mode = features.isMintLogPrimaryEnabled()
    ? 'primary'
    : features.isMintLogShadowEnabled()
      ? 'shadow'
      : 'off';
  const recordVerifier = getMintPrincipalBindings() !== null;
  const gateway = getMintGateway() !== null;
  const problems: string[] = [];
  if (mode === 'primary' && !recordVerifier) {
    problems.push(
      'PRIMARY is on but no principal bindings are bound: every admin minting write answers 503'
    );
  }
  if (mode === 'shadow' && !recordVerifier) {
    problems.push(
      'no principal bindings are bound: signed records are not checked, and the shadow log keeps none'
    );
  }
  if (decisionIds.length && !gateway) {
    problems.push(
      'MAIN_STAGE_DECISION_IDS is set but no gateway is bound: chain claim messages are refused'
    );
  }
  return { mode, recordVerifier, gateway, problems };
}

export function describeMintLogReadiness(
  readiness: MintLogReadiness = mintLogReadiness()
): string {
  const state = `[MINT_LOG] [MODE ${readiness.mode}] [RECORD VERIFIER ${readiness.recordVerifier ? 'bound' : 'unbound'}] [GATEWAY ${readiness.gateway ? 'bound' : 'unbound'}]`;
  return readiness.problems.length
    ? `${state} [NOT READY] ${readiness.problems.join('; ')}`
    : state;
}
