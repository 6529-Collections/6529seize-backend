import {
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../sql-executor';
import { RefreshToken } from '../../../entities/IRefreshToken';
import {
  REFRESH_TOKENS_TABLE,
  WALLET_AUTH_SESSIONS_TABLE,
  WALLET_CONNECTION_TRANSFERS_TABLE
} from '@/constants';
import { randomBytes } from 'node:crypto';
import { equalIgnoreCase } from '../../../strings';
import {
  WalletAuthClientType,
  WalletAuthSessionEntity
} from '../../../entities/IWalletAuthSession';
import { WalletConnectionTransferEntity } from '../../../entities/IWalletConnectionTransfer';

const CLIENT_TYPE_WEB: WalletAuthClientType = 'web';
const CLIENT_TYPE_NATIVE: WalletAuthClientType = 'native';

type CreateWalletAuthSessionParams = {
  readonly id: string;
  readonly address: string;
  readonly role: string | null;
  readonly clientType: WalletAuthClientType;
  readonly secretHash: string | null;
  readonly refreshTokenHash: string | null;
  readonly userAgentHash: string | null;
  readonly expiresAt: Date;
};

type CreateWalletConnectionTransferParams = {
  readonly id: string;
  readonly transferCodeHash: string;
  readonly address: string;
  readonly role: string | null;
  readonly targetClientType: WalletAuthClientType;
  readonly expiresAt: Date;
};

export class AuthDb extends LazyDbAccessCompatibleService {
  async retrieveOrGenerateRefreshToken(address: string): Promise<string> {
    const existingToken = await this.db.oneOrNull<RefreshToken>(
      `select refresh_token from ${REFRESH_TOKENS_TABLE} where address = :address`,
      { address }
    );
    if (existingToken) {
      return existingToken.refresh_token;
    }
    const refreshToken = randomBytes(64).toString('hex');
    await this.db.execute(
      `insert into ${REFRESH_TOKENS_TABLE} (address, refresh_token) values (:address, :refreshToken)`,
      { address, refreshToken }
    );
    return refreshToken;
  }

  async redeemRefreshToken(
    address: string,
    refreshToken: string
  ): Promise<boolean> {
    const result = await this.db.oneOrNull<RefreshToken>(
      `select address from ${REFRESH_TOKENS_TABLE} where refresh_token = :refreshToken`,
      { refreshToken }
    );
    return !!result?.address && equalIgnoreCase(address, result.address);
  }

  async createWalletAuthSession(
    params: CreateWalletAuthSessionParams
  ): Promise<WalletAuthSessionEntity> {
    await this.db.execute(
      `insert into ${WALLET_AUTH_SESSIONS_TABLE}
       (id, address, role, client_type, secret_hash, refresh_token_hash, user_agent_hash, expires_at)
       values (:id, :address, :role, :clientType, :secretHash, :refreshTokenHash, :userAgentHash, :expiresAt)`,
      params
    );
    return this.getWalletAuthSessionByIdOrThrow(params.id);
  }

  async getActiveWebSessionBySecretHash(
    id: string,
    secretHash: string,
    now: Date
  ): Promise<WalletAuthSessionEntity | null> {
    return this.db.oneOrNull<WalletAuthSessionEntity>(
      `select * from ${WALLET_AUTH_SESSIONS_TABLE}
       where id = :id
         and client_type = :clientType
         and secret_hash = :secretHash
         and revoked_at is null
         and expires_at > :now`,
      { id, secretHash, now, clientType: CLIENT_TYPE_WEB }
    );
  }

  async getActiveNativeSessionByRefreshHash(
    address: string,
    refreshTokenHash: string,
    now: Date
  ): Promise<WalletAuthSessionEntity | null> {
    return this.db.oneOrNull<WalletAuthSessionEntity>(
      `select * from ${WALLET_AUTH_SESSIONS_TABLE}
       where address = :address
         and client_type = :clientType
         and refresh_token_hash = :refreshTokenHash
         and revoked_at is null
         and expires_at > :now`,
      { address, refreshTokenHash, now, clientType: CLIENT_TYPE_NATIVE }
    );
  }

  async rotateWebSessionSecret(params: {
    readonly sessionId: string;
    readonly previousSecretHash: string;
    readonly nextSecretHash: string;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<WalletAuthSessionEntity | null> {
    const result = await this.db.execute(
      `update ${WALLET_AUTH_SESSIONS_TABLE}
       set secret_hash = :nextSecretHash,
           expires_at = :expiresAt,
           last_used_at = :now
       where id = :sessionId
         and client_type = :clientType
         and secret_hash = :previousSecretHash
         and revoked_at is null
         and expires_at > :now`,
      { ...params, clientType: CLIENT_TYPE_WEB }
    );
    if (this.db.getAffectedRows(result) !== 1) {
      return null;
    }
    return this.getWalletAuthSessionByIdOrThrow(params.sessionId);
  }

  async rotateNativeSessionRefreshToken(params: {
    readonly sessionId: string;
    readonly previousRefreshTokenHash: string;
    readonly nextRefreshTokenHash: string;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<WalletAuthSessionEntity | null> {
    const result = await this.db.execute(
      `update ${WALLET_AUTH_SESSIONS_TABLE}
       set refresh_token_hash = :nextRefreshTokenHash,
           expires_at = :expiresAt,
           last_used_at = :now
       where id = :sessionId
         and client_type = :clientType
         and refresh_token_hash = :previousRefreshTokenHash
         and revoked_at is null
         and expires_at > :now`,
      { ...params, clientType: CLIENT_TYPE_NATIVE }
    );
    if (this.db.getAffectedRows(result) !== 1) {
      return null;
    }
    return this.getWalletAuthSessionByIdOrThrow(params.sessionId);
  }

  async revokeWalletAuthSession(sessionId: string, now: Date): Promise<void> {
    await this.db.execute(
      `update ${WALLET_AUTH_SESSIONS_TABLE}
       set revoked_at = coalesce(revoked_at, :now)
       where id = :sessionId`,
      { sessionId, now }
    );
  }

  async revokeWalletAuthSessionByRefreshHash(
    refreshTokenHash: string,
    now: Date
  ): Promise<void> {
    await this.db.execute(
      `update ${WALLET_AUTH_SESSIONS_TABLE}
       set revoked_at = coalesce(revoked_at, :now)
       where refresh_token_hash = :refreshTokenHash`,
      { refreshTokenHash, now }
    );
  }

  async revokeWalletAuthSessionsForAddress(
    address: string,
    now: Date
  ): Promise<void> {
    await this.db.execute(
      `update ${WALLET_AUTH_SESSIONS_TABLE}
       set revoked_at = coalesce(revoked_at, :now)
       where address = :address and revoked_at is null`,
      { address, now }
    );
  }

  async createWalletConnectionTransfer(
    params: CreateWalletConnectionTransferParams
  ): Promise<WalletConnectionTransferEntity> {
    await this.db.execute(
      `insert into ${WALLET_CONNECTION_TRANSFERS_TABLE}
       (id, transfer_code_hash, address, role, target_client_type, expires_at)
       values (:id, :transferCodeHash, :address, :role, :targetClientType, :expiresAt)`,
      params
    );
    return this.getWalletConnectionTransferByIdOrThrow(params.id);
  }

  async consumeWalletConnectionTransfer(params: {
    readonly transferCodeHash: string;
    readonly targetClientType: WalletAuthClientType;
    readonly now: Date;
  }): Promise<WalletConnectionTransferEntity | null> {
    const result = await this.db.execute(
      `update ${WALLET_CONNECTION_TRANSFERS_TABLE}
       set consumed_at = :now
       where transfer_code_hash = :transferCodeHash
         and target_client_type = :targetClientType
         and consumed_at is null
         and expires_at > :now`,
      params
    );
    if (this.db.getAffectedRows(result) !== 1) {
      return null;
    }
    return this.db.oneOrNull<WalletConnectionTransferEntity>(
      `select * from ${WALLET_CONNECTION_TRANSFERS_TABLE}
       where transfer_code_hash = :transferCodeHash`,
      { transferCodeHash: params.transferCodeHash }
    );
  }

  async markWalletConnectionTransferSession(
    transferId: string,
    sessionId: string
  ): Promise<void> {
    await this.db.execute(
      `update ${WALLET_CONNECTION_TRANSFERS_TABLE}
       set consumed_session_id = :sessionId
       where id = :transferId`,
      { transferId, sessionId }
    );
  }

  private async getWalletAuthSessionByIdOrThrow(
    id: string
  ): Promise<WalletAuthSessionEntity> {
    const session = await this.db.oneOrNull<WalletAuthSessionEntity>(
      `select * from ${WALLET_AUTH_SESSIONS_TABLE} where id = :id`,
      { id }
    );
    if (!session) {
      throw new Error(`Wallet auth session ${id} not found after write`);
    }
    return session;
  }

  private async getWalletConnectionTransferByIdOrThrow(
    id: string
  ): Promise<WalletConnectionTransferEntity> {
    const transfer = await this.db.oneOrNull<WalletConnectionTransferEntity>(
      `select * from ${WALLET_CONNECTION_TRANSFERS_TABLE} where id = :id`,
      { id }
    );
    if (!transfer) {
      throw new Error(`Wallet connection transfer ${id} not found after write`);
    }
    return transfer;
  }
}

export const authDb = new AuthDb(dbSupplier);
