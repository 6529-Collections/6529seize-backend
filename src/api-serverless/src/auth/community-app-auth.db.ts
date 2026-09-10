import { CommunityAppClientEntity } from '../../../entities/ICommunityAppClient';
import { CommunityAppDeviceCodeEntity } from '../../../entities/ICommunityAppDeviceCode';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';

export type CreateDeviceCodeParams = {
  readonly id: string;
  readonly deviceCodeHash: string;
  readonly userCodeHash: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly pkceCodeChallenge: string;
  readonly pkceCodeChallengeMethod: string;
  readonly expiresAt: Date;
};

export class CommunityAppAuthDb extends LazyDbAccessCompatibleService {
  async getActiveClient(clientId: string): Promise<CommunityAppClientEntity | null> {
    return this.db.oneOrNull<CommunityAppClientEntity>(
      `SELECT * FROM community_app_clients WHERE client_id = :clientId AND is_active = 1`,
      { clientId }
    );
  }

  async createDeviceCode(params: CreateDeviceCodeParams): Promise<void> {
    await this.db.execute(
      `INSERT INTO community_app_device_codes
       (id, device_code_hash, user_code_hash, client_id, redirect_uri, scope,
        pkce_code_challenge, pkce_code_challenge_method, created_at, expires_at)
       VALUES
       (:id, :deviceCodeHash, :userCodeHash, :clientId, :redirectUri, :scope,
        :pkceCodeChallenge, :pkceCodeChallengeMethod, NOW(3), :expiresAt)`,
      params
    );
  }

  async findPendingDeviceCodeByUserCode(
    userCodeHash: string
  ): Promise<CommunityAppDeviceCodeEntity | null> {
    return this.db.oneOrNull<CommunityAppDeviceCodeEntity>(
      `SELECT * FROM community_app_device_codes
       WHERE user_code_hash = :userCodeHash
         AND approved_at IS NULL
         AND consumed_at IS NULL
         AND expires_at > NOW(3)`,
      { userCodeHash }
    );
  }

  async approveDeviceCode(
    deviceCodeId: string,
    address: string,
    role: string | null,
    connection: ConnectionWrapper<any>
  ): Promise<CommunityAppDeviceCodeEntity | null> {
    const result = await connection.execute(
      `UPDATE community_app_device_codes
       SET approved_at = NOW(3),
           approved_by_address = :address,
           approved_by_role = :role
       WHERE id = :deviceCodeId
         AND approved_at IS NULL
         AND consumed_at IS NULL
         AND expires_at > NOW(3)`,
      { deviceCodeId, address, role }
    );
    if (result.affectedRows === 0) return null;
    return this.db.oneOrNull<CommunityAppDeviceCodeEntity>(
      `SELECT * FROM community_app_device_codes WHERE id = :deviceCodeId`,
      { deviceCodeId }
    );
  }

  async consumeDeviceCode(
    deviceCodeHash: string,
    connection: ConnectionWrapper<any>
  ): Promise<CommunityAppDeviceCodeEntity | null> {
    const result = await connection.execute(
      `UPDATE community_app_device_codes
       SET consumed_at = NOW(3)
       WHERE device_code_hash = :deviceCodeHash
         AND approved_at IS NOT NULL
         AND consumed_at IS NULL
         AND expires_at > NOW(3)`,
      { deviceCodeHash }
    );
    if (result.affectedRows === 0) return null;
    return this.db.oneOrNull<CommunityAppDeviceCodeEntity>(
      `SELECT * FROM community_app_device_codes WHERE device_code_hash = :deviceCodeHash`,
      { deviceCodeHash }
    );
  }
}

export const communityAppAuthDb = new CommunityAppAuthDb(dbSupplier);