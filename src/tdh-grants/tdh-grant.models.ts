import { Time } from '../time';
import { TdhGrantEntity, TdhGrantStatus } from '../entities/ITdhGrant';

export interface CreateTdhGrantCommand {
  target_chain: number;
  target_contract: string;
  target_tokens: string[];
  valid_to: Time | null;
  tdh_rate: number;
  is_irrevocable: boolean;
  grantor_id: string;
}

export interface TdhGrantModel {
  id: string;
  target_chain: number;
  target_contract: string;
  target_collection_name: string | null;
  target_token_count: number;
  valid_to: Time | null;
  valid_from: Time | null;
  status: TdhGrantStatus;
  error_details: string | null;
  created_at: Time;
  updated_at: Time;
  tdh_rate: number;
  is_irrevocable: boolean;
  grantor_id: string;
}

export function fromTdhGrantEntityToModel(
  entity: TdhGrantEntity & {
    target_token_count: number;
    target_collection_name: string;
  }
): TdhGrantModel {
  return {
    id: entity.id,
    target_chain: entity.target_chain,
    target_contract: entity.target_contract,
    target_collection_name: entity.target_collection_name,
    target_token_count: entity.target_token_count,
    valid_from:
      entity.valid_from === null ? null : Time.millis(entity.valid_from),
    valid_to: entity.valid_to ? Time.millis(entity.valid_to) : null,
    created_at: Time.millis(entity.created_at),
    updated_at: Time.millis(entity.updated_at),
    status: entity.status,
    error_details: entity.error_details,
    tdh_rate: entity.tdh_rate,
    is_irrevocable: entity.is_irrevocable,
    grantor_id: entity.grantor_id
  };
}
