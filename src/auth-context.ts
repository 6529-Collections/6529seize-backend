import { ApiProfileProxyActionType } from './entities/IProfileProxyAction';
import { resolveEnum } from './helpers';

export class AuthenticationContext {
  readonly authenticatedWallet: string;
  readonly authenticatedProfileId: string | null;
  readonly roleProfileId: string | null;
  readonly activeProxyActions: Partial<
    Record<ApiProfileProxyActionType, AuthenticatedProxyAction>
  >;

  constructor({
    authenticatedWallet,
    authenticatedProfileId,
    roleProfileId,
    activeProxyActions
  }: {
    readonly authenticatedWallet: string;
    readonly authenticatedProfileId: string | null;
    readonly roleProfileId: string | null;
    readonly activeProxyActions: AuthenticatedProxyAction[];
  }) {
    this.authenticatedWallet = authenticatedWallet;
    this.authenticatedProfileId = authenticatedProfileId;
    this.roleProfileId = roleProfileId;
    this.activeProxyActions = activeProxyActions.reduce((acc, action) => {
      const type = resolveEnum(ApiProfileProxyActionType, action.type);
      if (type) {
        acc[type] = action;
      }
      return acc;
    }, {} as Record<ApiProfileProxyActionType, AuthenticatedProxyAction>);
  }

  public isAuthenticatedAsProxy(): boolean {
    return (
      this.roleProfileId !== null &&
      this.roleProfileId !== undefined &&
      this.authenticatedProfileId !== this.roleProfileId
    );
  }

  public getActingAsId(): string | null {
    return this.isAuthenticatedAsProxy()
      ? this.roleProfileId!
      : this.authenticatedProfileId ?? null;
  }
}

export interface AuthenticatedProxyAction {
  readonly id: string;
  readonly type: ApiProfileProxyActionType;
  readonly credit_amount: number | null;
  readonly credit_spent: number | null;
}
