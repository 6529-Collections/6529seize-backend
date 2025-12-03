import { Time } from '../time';
import { XTdhGrantEntity, XTdhGrantStatus } from '../entities/IXTdhGrant';

export interface CreateXTdhGrantCommand {
  target_chain: number;
  target_contract: string;
  target_tokens: string[];
  valid_to: Time | null;
  rate: number;
  is_irrevocable: boolean;
  grantor_id: string;
}

export interface XTdhGrantModel {
  id: string;
  target_chain: number;
  target_contract: string;
  target_collection_name: string | null;
  target_token_count: number;
  valid_to: Time | null;
  valid_from: Time | null;
  status: XTdhGrantStatus;
  error_details: string | null;
  created_at: Time;
  updated_at: Time;
  rate: number;
  is_irrevocable: boolean;
  grantor_id: string;
  total_granted: number;
}

export function fromXTdhGrantEntityToModel(
  entity: XTdhGrantEntity,
  metadata: {
    target_token_count: number;
    target_collection_name: string;
    total_granted: number;
  }
): XTdhGrantModel {
  return {
    id: entity.id,
    target_chain: entity.target_chain,
    target_contract: entity.target_contract,
    target_collection_name: metadata.target_collection_name,
    target_token_count: metadata.target_token_count,
    valid_from:
      entity.valid_from === null ? null : Time.millis(entity.valid_from),
    valid_to: entity.valid_to ? Time.millis(entity.valid_to) : null,
    created_at: Time.millis(entity.created_at),
    updated_at: Time.millis(entity.updated_at),
    status: entity.status,
    error_details: entity.error_details,
    rate: entity.rate,
    is_irrevocable: entity.is_irrevocable,
    grantor_id: entity.grantor_id,
    total_granted: metadata.total_granted
  };
}
