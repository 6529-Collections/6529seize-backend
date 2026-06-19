export const HELP_BOT_PUBLIC_DATA_TABLES = {
  nfts: [
    'id',
    'name',
    'artist',
    'mint_date',
    'supply',
    'hodl_rate',
    'boosted_tdh',
    'tdh',
    'tdh__raw',
    'tdh_rank'
  ],
  memes_extended_data: [
    'id',
    'season',
    'meme',
    'meme_name',
    'collection_size',
    'edition_size',
    'edition_size_rank',
    'edition_size_cleaned',
    'hodlers',
    'hodlers_rank',
    'percent_unique',
    'burnt',
    'edition_size_not_burnt'
  ],
  memes_seasons: [
    'id',
    'start_index',
    'end_index',
    'count',
    'name',
    'display',
    'boost'
  ],
  latest_tdh_global_history: [
    'date',
    'block',
    'memes_balance',
    'gradients_balance',
    'nextgen_balance',
    'total_boosted_tdh',
    'total_tdh',
    'total_tdh__raw',
    'memes_boosted_tdh',
    'memes_tdh',
    'memes_tdh__raw',
    'total_consolidated_wallets',
    'total_wallets'
  ]
} as const;

export type HelpBotPublicDataTable = keyof typeof HELP_BOT_PUBLIC_DATA_TABLES;

export const HELP_BOT_PUBLIC_DATA_ALLOWED_TABLES = new Set<string>(
  Object.keys(HELP_BOT_PUBLIC_DATA_TABLES)
);

export const HELP_BOT_PUBLIC_DATA_CATALOG = `
Public 6529 data schema available for @6529help SQL planning.

Rules:
- Only answer public aggregate or public NFT/Meme Card lookup questions.
- Use one SELECT statement only.
- Select explicit columns; never use SELECT *.
- Do not use UNION, subqueries, comments, semicolons, or comma-separated table lists.
- Use explicit JOIN syntax when multiple tables are needed.
- Prefer aggregate queries for "how many", "total", "highest", "lowest", "average".
- Add LIMIT ${10} for every answer.
- Use /the-memes for Meme Card answers and /network/tdh for TDH totals.

Tables:

nfts:
- One row per 6529 NFT token in the main NFT table.
- Useful columns: id, name, artist, mint_date, supply, hodl_rate, boosted_tdh, tdh, tdh__raw, tdh_rank.
- For Meme Card TDH rate questions, use nfts.hodl_rate.
- For Meme Card TDH questions, use nfts.boosted_tdh, nfts.tdh, or nfts.tdh__raw.

memes_extended_data:
- One row per Meme Card with season and edition metrics.
- Useful columns: id, season, meme, meme_name, collection_size, edition_size, edition_size_rank, edition_size_cleaned, hodlers, percent_unique, burnt, edition_size_not_burnt.
- Join nfts to memes_extended_data on nfts.id = memes_extended_data.id for Meme Card names plus TDH/rate fields.
- "Meme #1" means memes_extended_data.meme = 1.
- "SZN1" or "season 1" means memes_extended_data.season = 1.

memes_seasons:
- One row per Meme Card season.
- Useful columns: id, start_index, end_index, count, name, display, boost.
- For "how many Meme Cards are in SZN1", either count memes_extended_data rows where season = 1 or use memes_seasons.count where id = 1.

latest_tdh_global_history:
- Latest global TDH totals.
- Useful columns: total_boosted_tdh, total_tdh, total_tdh__raw, memes_boosted_tdh, memes_tdh, memes_tdh__raw, total_consolidated_wallets, total_wallets, date, block.
- For "total TDH", use total_boosted_tdh unless the user asks for raw or unboosted.

Examples:
- Question: "how many memes are in szn1"
  SQL: SELECT COUNT(*) AS meme_count FROM memes_extended_data WHERE season = 1 LIMIT 10
  canonical_path: /the-memes?szn=1
- Question: "what is the tdh rate of meme #1"
  SQL: SELECT m.meme, m.meme_name, n.hodl_rate AS tdh_rate FROM memes_extended_data m JOIN nfts n ON n.id = m.id WHERE m.meme = 1 LIMIT 1
  canonical_path: /the-memes/1
- Question: "what is the highest tdh rate"
  SQL: SELECT m.meme, m.meme_name, n.hodl_rate AS tdh_rate FROM memes_extended_data m JOIN nfts n ON n.id = m.id ORDER BY n.hodl_rate DESC LIMIT 1
  canonical_path: /the-memes
- Question: "highest edition size"
  SQL: SELECT meme, meme_name, edition_size FROM memes_extended_data ORDER BY edition_size DESC LIMIT 1
  canonical_path: /the-memes
- Question: "total tdh"
  SQL: SELECT total_boosted_tdh AS total_tdh, date, block FROM latest_tdh_global_history LIMIT 1
  canonical_path: /network/tdh
`;
