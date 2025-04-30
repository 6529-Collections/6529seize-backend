import { Profile, ProfileClassification } from '../entities/IProfile';
import { Wallet } from '../entities/IWallet';
import { AggregatedCicRating } from '../rates/rates.types';

export interface CreateOrUpdateProfileCommand {
  handle: string;
  banner_1?: string | null;
  banner_2?: string | null;
  website?: string | null;
  creator_or_updater_wallet: string;
  classification: ProfileClassification;
  sub_classification: string | null;
  pfp_url: string | null;
}

export interface ProfileAndConsolidations {
  readonly profile: Profile | null;
  readonly consolidation: {
    wallets: { wallet: Wallet; tdh: number }[];
    tdh: number;
    consolidation_key: string | null;
    consolidation_display: string | null;
  };
  level: number;
  cic: AggregatedCicRating;
  rep: number;
  balance: number;
  readonly input_identity: string;
}
