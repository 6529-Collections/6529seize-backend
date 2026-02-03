import { Network } from 'alchemy-sdk';

export const TDH_BLOCKS_TABLE = 'tdh_blocks';
export const TRANSACTIONS_TABLE = 'transactions';
export const TRANSACTIONS_PROCESSED_DISTRIBUTION_BLOCKS_TABLE =
  'transactions_processed_distribution_blocks';
export const TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE =
  'transactions_processed_subscriptions_blocks';
export const NFTS_TABLE = 'nfts';
export const NFTS_MEME_LAB_TABLE = 'nfts_meme_lab';
export const MEME_LAB_ROYALTIES_TABLE = 'meme_lab_royalties';
export const ARTISTS_TABLE = 'artists';
export const NFT_OWNERS_TABLE = 'nft_owners';
export const NFT_OWNERS_CONSOLIDATION_TABLE = 'nft_owners_consolidation';
export const NFT_OWNERS_SYNC_STATE_TABLE = 'nft_owners_sync_state';
export const MEMES_EXTENDED_DATA_TABLE = 'memes_extended_data';
export const LAB_EXTENDED_DATA_TABLE = 'lab_extended_data';
export const WALLETS_TDH_TABLE = 'tdh';
export const CONSOLIDATED_WALLETS_TDH_TABLE = 'tdh_consolidation';
export const HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE =
  'historic_tdh_consolidation';
export const WALLETS_TDH_MEMES_TABLE = 'tdh_memes';
export const CONSOLIDATED_WALLETS_TDH_MEMES_TABLE = 'tdh_memes_consolidation';
export const TDH_NFT_TABLE = 'tdh_nft';
export const TDH_EDITIONS_TABLE = 'tdh_editions';
export const CONSOLIDATED_TDH_EDITIONS_TABLE = 'tdh_editions_consolidation';
export const UPLOADS_TABLE = 'uploads';
export const CONSOLIDATED_UPLOADS_TABLE = 'uploads_consolidation';
export const ENS_TABLE = 'ens';
export const ABUSIVENESS_DETECTION_RESULTS_TABLE =
  'abusiveness_detection_results';
export const CIC_STATEMENTS_TABLE = 'cic_statements';
export const RATINGS_SNAPSHOTS_TABLE = 'ratings_snapshots';
export const USER_GROUPS_TABLE = 'community_groups';
export const PROFILE_GROUPS_TABLE = 'profile_groups';
export const PROFILES_TABLE = 'profiles';
export const PROFILES_ACTIVITY_LOGS_TABLE = 'profile_activity_logs';
export const PROFILE_LATEST_LOG_TABLE = 'profile_latest_logs';
export const PROFILES_ARCHIVE_TABLE = 'profiles_archive';
export const REFRESH_TOKENS_TABLE = 'refresh_tokens';
export const IDENTITIES_TABLE = 'identities';
export const ADDRESS_CONSOLIDATION_KEY = 'address_consolidation_keys';
export const TEAM_TABLE = 'team';
export const DISTRIBUTION_TABLE = 'distribution';
export const DISTRIBUTION_PHOTO_TABLE = 'distribution_photo';
export const DISTRIBUTION_NORMALIZED_TABLE = 'distribution_normalized';
export const TDH_GLOBAL_HISTORY_TABLE = 'tdh_global_history';
export const TDH_HISTORY_TABLE = 'tdh_history';
export const LATEST_TDH_GLOBAL_HISTORY_TABLE = 'latest_tdh_global_history';
export const LATEST_TDH_HISTORY_TABLE = 'latest_tdh_history';
export const RECENT_TDH_HISTORY_TABLE = 'recent_tdh_history';
export const NFTDELEGATION_BLOCKS_TABLE = 'nftdelegation_blocks';
export const CONSOLIDATIONS_TABLE = 'consolidations';
export const DELEGATIONS_TABLE = 'delegations';
export const DROP_RELATIONS_TABLE = 'drop_relations';
export const NFTS_HISTORY_TABLE = 'nfts_history';
export const NFTS_HISTORY_BLOCKS_TABLE = 'nfts_history_blocks';
export const NFTS_HISTORY_CLAIMS_TABLE = 'nfts_history_claims';
export const REMEMES_TABLE = 'rememes';
export const REMEMES_UPLOADS = 'uploads_rememes';
export const RATINGS_TABLE = 'ratings';
export const DROPS_VOTES_CREDIT_SPENDINGS_TABLE =
  'drops_votes_credit_spendings';
export const DROP_VOTER_STATE_TABLE = 'drop_voter_states';
export const DROP_REACTIONS_TABLE = 'drop_reactions';
export const DROP_REAL_VOTER_VOTE_IN_TIME_TABLE =
  'drop_real_voter_vote_in_time';
export const EXTERNAL_INDEXED_CONTRACTS_TABLE = 'external_indexed_contracts';
export const EXTERNAL_INDEXED_OWNERSHIP_721_TABLE =
  'external_indexed_ownership_721s';
export const EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE =
  'external_indexed_ownership_721_histories';
export const EXTERNAL_INDEXED_TRANSFERS_TABLE = 'external_indexed_transfers';
export const WINNER_DROP_VOTER_VOTES_TABLE = 'winner_drop_voter_votes';
export const DROP_RANK_TABLE = 'drop_ranks';
export const DROP_REAL_VOTE_IN_TIME_TABLE = 'drop_real_vote_in_time';
export const WAVE_LEADERBOARD_ENTRIES_TABLE = 'wave_leaderboard_entries';
export const ROYALTIES_UPLOADS_TABLE = 'royalties_upload';
export const EVENTS_TABLE = 'events';
export const LISTENER_PROCESSED_EVENTS_TABLE = 'listener_processed_events';
export const CIC_SCORE_AGGREGATIONS_TABLE = 'cic_score_aggregations';
export const PROFILE_TOTAL_REP_SCORE_AGGREGATIONS_TABLE =
  'profile_total_rep_score_aggregations';
export const MEMES_SEASONS_TABLE = 'memes_seasons';
export const AGGREGATED_ACTIVITY_TABLE = 'aggregated_activity';
export const AGGREGATED_ACTIVITY_MEMES_TABLE = 'aggregated_activity_memes';
export const CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE =
  'aggregated_activity_consolidation';
export const CONSOLIDATED_AGGREGATED_ACTIVITY_MEMES_TABLE =
  'aggregated_activity_memes_consolidation';
export const OWNERS_BALANCES_TABLE = 'owners_balances';
export const OWNERS_BALANCES_MEMES_TABLE = 'owners_balances_memes';
export const CONSOLIDATED_OWNERS_BALANCES_TABLE =
  'owners_balances_consolidation';
export const CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE =
  'owners_balances_memes_consolidation';

export const SUBSCRIPTIONS_TOP_UP_TABLE = 'subscriptions_top_up';
export const SUBSCRIPTIONS_TOP_UP_LATEST_BLOCK_TABLE =
  'subscriptions_top_up_latest_block';
export const SUBSCRIPTIONS_BALANCES_TABLE = 'subscriptions_balances';
export const SUBSCRIPTIONS_MODE_TABLE = 'subscriptions_mode';
export const SUBSCRIPTIONS_NFTS_TABLE = 'subscriptions_nfts';
export const SUBSCRIPTIONS_NFTS_FINAL_TABLE = 'subscriptions_nfts_final';
export const SUBSCRIPTIONS_NFTS_FINAL_UPLOAD_TABLE =
  'subscriptions_nfts_final_upload';
export const SUBSCRIPTIONS_LOGS_TABLE = 'subscriptions_logs';
export const SUBSCRIPTIONS_REDEEMED_TABLE = 'subscriptions_redeemed';
export const SUBSCRIPTIONS_ADMIN_WALLETS = [
  '0x0187C9a182736ba18b44eE8134eE438374cf87DC',
  '0xFe49A85E98941F1A115aCD4bEB98521023a25802'
];

export const XTDH_GRANTS_TABLE = 'xtdh_grants';
export const XTDH_GRANT_TOKENS_TABLE = 'xtdh_grant_tokens';

export const DELETED_DROPS_TABLE = 'deleted_drops';
export const DROPS_TABLE = 'drops';
export const DROPS_PARTS_TABLE = 'drops_parts';
export const PROFILE_PROXIES_TABLE = 'profile_proxies';
export const PROFILE_PROXY_ACTIONS_TABLE = 'profile_proxy_actions';
export const WAVES_TABLE = 'waves';
export const WAVE_OUTCOMES_TABLE = 'wave_outcomes';
export const WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE =
  'wave_outcome_distribution_items';
export const WAVES_DECISION_PAUSES_TABLE = 'waves_decision_pauses';
export const WAVES_ARCHIVE_TABLE = 'waves_archive';
export const WAVES_DECISIONS_TABLE = 'wave_decisions';
export const WAVES_DECISION_WINNER_DROPS_TABLE = 'wave_decision_winner_drops';
export const MEMES_CLAIMS_TABLE = 'memes_claims';
export const WAVE_METRICS_TABLE = 'wave_metrics';
export const WAVE_DROPPER_METRICS_TABLE = 'wave_dropper_metrics';
export const WAVE_READER_METRICS_TABLE = 'wave_reader_metrics';
export const METRIC_ROLLUP_HOUR_TABLE = 'metric_rollup_hour';
export const DROPS_MENTIONS_TABLE = 'drops_mentions';
export const DROP_MENTIONED_WAVES_TABLE = 'drop_mentioned_waves';
export const DROP_REFERENCED_NFTS_TABLE = 'drops_referenced_nfts';
export const DROP_METADATA_TABLE = 'drops_metadatas';
export const DROP_MEDIA_TABLE = 'drop_medias';
export const DROP_BOOSTS_TABLE = 'drop_boosts';
export const DROP_BOOKMARKS_TABLE = 'drop_bookmarks';
export const PINNED_WAVES_TABLE = 'pinned_waves';

export const COOKIES_CONSENT_TABLE = 'cookies_consent';
export const PROFILE_GROUP_CHANGES = 'profile_group_changes';
export const EULA_CONSENT_TABLE = 'eula_consent';
export const ETH_PRICE_TABLE = 'eth_price';

export const PRENODES_TABLE = 'prenodes';

export const PUSH_NOTIFICATION_DEVICES_TABLE = 'push_notification_devices';
export const PUSH_NOTIFICATION_SETTINGS_TABLE = 'push_notification_settings';

export const IDENTITY_SUBSCRIPTIONS_TABLE = 'identity_subscriptions';
export const IDENTITY_NOTIFICATIONS_TABLE = 'identity_notifications';
export const ACTIVITY_EVENTS_TABLE = 'activity_events';

export const XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX = 'xtdh_token_grant_stats_';
export const XTDH_TOKEN_STATS_TABLE_PREFIX = 'xtdh_token_stats_';
export const XTDH_STATS_META_TABLE = 'xtdh_stats_meta';

export const WS_CONNECTIONS_TABLE = 'ws_connections';

export const MEMES_CONTRACT = '0x33FD426905F149f8376e227d0C9D3340AaD17aF1';
export const GRADIENT_CONTRACT = '0x0c58ef43ff3032005e472cb5709f8908acb00205';
export const MEMELAB_CONTRACT = '0x4db52a61dc491e15a2f78f5ac001c14ffe3568cb';
export const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';
export const NULL_ADDRESS_DEAD = '0x000000000000000000000000000000000000dEaD';
export const MANIFOLD = '0x3A3548e060Be10c2614d0a4Cb0c03CC9093fD799';
export const PUNK_6529 = '0xfd22004806a6846ea67ad883356be810f0428793';
export const SIX529 = '0xB7d6ed1d7038BaB3634eE005FA37b925B11E9b13';
export const SIX529_ER = '0xE359aB04cEC41AC8C62bc5016C10C749c7De5480';
export const SIX529_MUSEUM = '0xc6400A5584db71e41B0E5dFbdC769b54B91256CD';
export const ENS_ADDRESS = '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85';
export const ROYALTIES_ADDRESS = '0x1b1289e34fe05019511d7b436a5138f361904df0';
export const MEMELAB_ROYALTIES_ADDRESS =
  '0x900b67e6f16291431e469e6ec8208d17de09fc37';
export const OPENSEA_ADDRESS = '0x0000000000000068F116a894984e2DB1123eB395';
export const OPENSEA_ADDRESS_1_5 = '0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC';
export const MEMES_DEPLOYER = '0x4B76837F8D8Ad0A28590d06E53dCD44b6B7D4554';

export const ACK_DEPLOYER = '0x03ee832367e29a5cd001f65093283eabb5382b62';
export const LOOKS_TOKEN_ADDRESS = '0xf4d2888d29d722226fafa5d9b24f9164c092421e';
export const WETH_TOKEN_ADDRESS = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

export const ALCHEMY_SETTINGS = {
  network: Network.ETH_MAINNET,
  maxRetries: 10
};

export const INFURA_KEY = 'b496145d088a4fe5a5861a6db9ee2034';

export const CLOUDFRONT_DISTRIBUTION = 'ECGWRHUV1NM3I';
export const CLOUDFRONT_ID = 'd3lqz0a4bldqgf';
export const CLOUDFRONT_LINK = `https://${CLOUDFRONT_ID}.cloudfront.net`;

export const NFT_ORIGINAL_IMAGE_LINK = `${CLOUDFRONT_LINK}/images/original/`;

export const NFT_SCALED1000_IMAGE_LINK = `${CLOUDFRONT_LINK}/images/scaled_x1000/`;

export const NFT_SCALED450_IMAGE_LINK = `${CLOUDFRONT_LINK}/images/scaled_x450/`;

export const NFT_SCALED60_IMAGE_LINK = `${CLOUDFRONT_LINK}/images/scaled_x60/`;

export const NFT_VIDEO_LINK = `${CLOUDFRONT_LINK}/videos/`;
export const NFT_HTML_LINK = `${CLOUDFRONT_LINK}/html/`;

// export const DELEGATION_CONTRACT: {
//   chain_id: number;
//   contract: `0x${string}`;
// } = {
//   chain_id: 11155111,
//   contract: '0x8f86c644f845a077999939c69bc787662377d915'
// };
export const DELEGATION_CONTRACT: {
  chain_id: number;
  contract: `0x${string}`;
} = {
  chain_id: 1,
  contract: '0x2202CB9c00487e7e8EF21e6d8E914B32e709f43d'
};
export const DELEGATION_ALL_ADDRESS =
  '0x8888888888888888888888888888888888888888';

export const USE_CASE_ALL = 1;
export const USE_CASE_MINTING = 2;
export const USE_CASE_AIRDROPS = 3;
export const USE_CASE_PRIMARY_ADDRESS = 997;
export const USE_CASE_SUB_DELEGATION = 998;
export const USE_CASE_CONSOLIDATION = 999;
export const CONSOLIDATIONS_LIMIT = 3;
export const NEVER_DATE = 64060588800;

export const WALLET_REGEX = /^0x[a-fA-F0-9]{40}$/;
export const PROFILE_HANDLE_REGEX = /^[a-zA-Z0-9_]{3,15}$/;
export const UUID_REGEX =
  /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/;
export const MEMES_ROYALTIES_RATE = 0.5;

export const MEME_8_EDITION_BURN_ADJUSTMENT = -2588;
export const MEME_8_BURN_TRANSACTION =
  '0xa6c27335d3c4f87064a938e987e36525885cc3d136ebb726f4c5d374c0d2d854';

export const SUBSCRIPTIONS_ADDRESS =
  '0xCaAc2b43b1b40eDBFAdDB5aebde9A90a27E1A3be';

export const MEMES_MINT_PRICE = 0.06529;
export const RESEARCH_6529_ADDRESS =
  '0xc2Ce4CCeF11A8171f443745cEa3BceEAadD750C7';

export const X_TDH_COEFFICIENT = 0.1;
