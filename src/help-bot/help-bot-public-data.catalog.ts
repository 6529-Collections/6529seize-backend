export const HELP_BOT_PUBLIC_DATA_CATALOG = `
Public 6529 data query catalog available for @6529help planning.

Rules:
- Return strict JSON only with the shape {"queryId":"...","params":{...}}.
- Do not return SQL.
- Return {"queryId":null} when no query id below fits the user's question.
- Only answer public aggregate or public Meme Card lookup questions.
- Use numeric params only.

Available query ids:

- memes_in_season_count
  Purpose: Count Meme Cards in one season.
  Params: {"season": number}
  Examples: "how many memes are in szn1", "count meme cards in season 2"
  Source tables: memes_extended_data.

- meme_tdh_rate
  Purpose: Look up one Meme Card's TDH rate.
  Params: {"meme": number}
  Examples: "what is the tdh rate of meme #1", "hodl rate for meme 42"
  Source tables: memes_extended_data, nfts.

- highest_tdh_rate
  Purpose: Find the Meme Card with the highest TDH rate.
  Params: {}
  Examples: "what is the highest tdh rate", "which card has the highest hodl rate"
  Source tables: memes_extended_data, nfts.

- highest_edition_size
  Purpose: Find the Meme Card with the highest edition size.
  Params: {}
  Examples: "highest edition size", "which meme has the biggest edition size"
  Source tables: memes_extended_data.

- highest_supply
  Purpose: Find the Meme Card with the highest NFT supply.
  Params: {}
  Examples: "highest supply", "which meme has the largest supply"
  Source tables: memes_extended_data, nfts.

- total_tdh
  Purpose: Look up the latest global total boosted TDH.
  Params: {}
  Examples: "total tdh", "what is the current total tdh"
  Source tables: latest_tdh_global_history.
`;
