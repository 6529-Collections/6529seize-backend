interface DistributionPhaseEntry {
  phase: string;
  spots: number;
}

export interface DistributionNormalized {
  card_id: number;
  contract: string;
  wallet: string;
  wallet_display: string;
  card_name: string;
  mint_date: Date;
  airdrops: number;
  total_spots: number;
  minted: number;
  allowlist: DistributionPhaseEntry[];
  total_count: number;
  phases: string[];
}
