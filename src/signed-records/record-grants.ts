import { deserializeDeviceGrantScopes } from '@/api/device-signing/device-grant-message';
import {
  deviceSigningDb,
  DeviceSigningDb
} from '@/api/device-signing/device-signing.db';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import type { RecordGrantProof } from './record-event';
import type { GrantProofSource } from './record-log/record-log.service';
import type { RecordGrantSource, VerifiedGrant } from './record-verify';

export function toVerifiedGrant(entity: DeviceGrantEntity): VerifiedGrant {
  return {
    id: entity.id,
    wallet: entity.wallet.toLowerCase(),
    deviceKey: entity.device_key.toLowerCase(),
    scopes: deserializeDeviceGrantScopes(entity.scopes),
    expiresAt: Number(entity.expires_at),
    revokedAt: entity.revoked_at === null ? null : Number(entity.revoked_at)
  };
}

/**
 * Grants from device_grants. 6529.io checked each one's wallet signature
 * when it registered it; a rebuild reads the same table after the waves
 * lane rebuilds it from the grant proofs on the relays.
 */
export class DeviceGrantRecordSource implements RecordGrantSource {
  constructor(private readonly db: DeviceSigningDb) {}

  async findGrant(grantId: string): Promise<VerifiedGrant | null> {
    const entity = await this.db.findGrantById(grantId.toLowerCase(), {});
    return entity ? toVerifiedGrant(entity) : null;
  }
}

export const deviceGrantRecordSource = new DeviceGrantRecordSource(
  deviceSigningDb
);

export function toRecordGrantProof(
  entity: DeviceGrantEntity
): RecordGrantProof {
  return {
    id: entity.id.toLowerCase(),
    message: entity.message,
    wallet_signature: entity.wallet_signature,
    chain_id: Number(entity.chain_id),
    wallet: entity.wallet.toLowerCase(),
    device_key: entity.device_key.toLowerCase(),
    scopes: deserializeDeviceGrantScopes(entity.scopes),
    domain: entity.domain,
    expires_at: Number(entity.expires_at),
    revoked_at: entity.revoked_at === null ? null : Number(entity.revoked_at)
  };
}

/** Grant proofs from device_grants, for the record log's event entries. */
export const deviceGrantProofSource: GrantProofSource = {
  async findGrantProofs(grantIds, ctx) {
    const entities = await deviceSigningDb.findGrantsByIds(
      grantIds.map((id) => id.toLowerCase()),
      ctx
    );
    return entities.map(toRecordGrantProof);
  }
};
