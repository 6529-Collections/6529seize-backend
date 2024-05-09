import { ApiProfileProxyActionType } from './entities/IProfileProxyAction';

export interface AuthenticationContext {
  readonly authenticatedWallet: string;
  readonly authenticatedProfileId: string | null;
  readonly roleProfileId: string | null;
  readonly activeProxyActions: AuthenticatedProxyAction[];
}

export interface AuthenticatedProxyAction {
  readonly id: string;
  readonly type: ApiProfileProxyActionType;
  readonly credit_amount: number | null;
  readonly credit_spent: number | null;
}
