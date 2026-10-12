import { ApiDeviceGrant } from '@/api/generated/models/ApiDeviceGrant';
import { ApiDeviceGrantProof } from '@/api/generated/models/ApiDeviceGrantProof';
import { ApiDeviceSignedEvent } from '@/api/generated/models/ApiDeviceSignedEvent';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import { DeviceSignedEventEntity } from '@/entities/IDeviceSignedEvent';
import { Logger } from '@/logging';
import { deserializeDeviceGrantScopes } from './device-grant-message';

const logger = Logger.get('DEVICE_SIGNING_MAPPERS');

function toApiScopes(entity: DeviceGrantEntity): string[] {
  const scopes = deserializeDeviceGrantScopes(entity.scopes);
  if (scopes.join(',') !== entity.scopes) {
    logger.warn(
      `Device grant ${entity.id} has unrecognised stored scopes: ${entity.scopes}`
    );
  }
  return scopes;
}

function toNullableNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

export function toApiDeviceGrant(entity: DeviceGrantEntity): ApiDeviceGrant {
  return {
    id: entity.id,
    wallet: entity.wallet,
    key_type: entity.key_type,
    device_key: entity.device_key,
    scopes: toApiScopes(entity),
    device_label: entity.device_label,
    domain: entity.domain,
    issued_at: Number(entity.issued_at),
    expires_at: Number(entity.expires_at),
    created_at: Number(entity.created_at),
    revoked_at: toNullableNumber(entity.revoked_at),
    last_used_at: toNullableNumber(entity.last_used_at)
  };
}

export function toApiDeviceGrantProof(
  entity: DeviceGrantEntity
): ApiDeviceGrantProof {
  return {
    ...toApiDeviceGrant(entity),
    message: entity.message,
    wallet_signature: entity.wallet_signature,
    chain_id: Number(entity.chain_id)
  };
}

function parseRefs(refs: string): string[] {
  const parsed: unknown = JSON.parse(refs);
  return Array.isArray(parsed)
    ? parsed.filter((ref): ref is string => typeof ref === 'string')
    : [];
}

export function toApiDeviceSignedEvent(
  entity: DeviceSignedEventEntity
): ApiDeviceSignedEvent {
  return {
    id: entity.id,
    kind: Number(entity.kind),
    kind_version: Number(entity.kind_version),
    wave: entity.wave_id,
    author: entity.author,
    key_type: Number(entity.key_type),
    device_key: entity.device_key,
    auth_ref: entity.grant_id,
    seq: Number(entity.seq),
    anchor: Number(entity.anchor),
    claimed_time: Number(entity.claimed_time),
    refs: parseRefs(entity.refs),
    body: entity.body,
    body_hash: entity.body_hash,
    body_size: Number(entity.body_size),
    signature: entity.signature,
    created_at: Number(entity.created_at)
  };
}
