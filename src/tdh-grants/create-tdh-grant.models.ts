import { Time } from '../time';
import { TdhGrantStatus } from '../entities/ITdhGrant';

export interface CreateTdhGrantCommand {
  target_chain: number;
  target_contract: string;
  target_tokens: string[];
  valid_to: Time;
  tdh_rate: number;
  is_irrevocable: boolean;
  grantor_id: string;
}

export interface TdhGrantModel {
  id: string;
  target_chain: number;
  target_contract: string;
  target_tokens: string[];
  valid_to: Time;
  valid_from: Time | null;
  status: TdhGrantStatus;
  error_details: string | null;
  created_at: Time;
  tdh_rate: number;
  is_irrevocable: boolean;
  grantor_id: string;
}
