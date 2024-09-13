import { ApiProfileProxyActionType } from './entities/IProfileProxyAction';
import { resolveEnum } from './helpers';

export class AuthenticationContext {
  readonly authenticatedWallet: string | null;
  readonly authenticatedProfileId: string | null;
  readonly roleProfileId: string | null;
  readonly activeProxyActions: Partial<
    Record<ApiProfileProxyActionType, AuthenticatedProxyAction>
  >;

  public static notAuthenticated(): AuthenticationContext {
    return new AuthenticationContext({
      authenticatedWallet: null,
      authenticatedProfileId: null,
      roleProfileId: null,
      activeProxyActions: []
    });
  }

  constructor({
    authenticatedWallet,
    authenticatedProfileId,
    roleProfileId,
    activeProxyActions
  }: {
    readonly authenticatedWallet: string | null;
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

  public isUserFullyAuthenticated(): boolean {
    return this.authenticatedProfileId !== null;
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

  public hasProxyAction(type: ApiProfileProxyActionType): boolean {
    return !!this.activeProxyActions[type];
  }

  static fromProfileId(contextProfileId: string) {
    return new AuthenticationContext({
      authenticatedWallet: null,
      authenticatedProfileId: contextProfileId,
      roleProfileId: null,
      activeProxyActions: []
    });
  }
}

export interface AuthenticatedProxyAction {
  readonly id: string;
  readonly type: ApiProfileProxyActionType;
  readonly credit_amount: number | null;
  readonly credit_spent: number | null;
}
