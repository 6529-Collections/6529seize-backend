export const HELP_BOT_PUBLIC_DATA_CATALOG = `
Public 6529 data query catalog available for @help6529 planning.

Rules:
- Return strict JSON only with the semantic plan shape below.
- Do not return SQL, table names, column names, joins, or expressions.
- Return {"entity":null} when the question is not answerable from this catalog.
- Only answer public aggregate or public Meme Card lookup questions.
- Use numeric filter and limit values only.
- Prefer limit 1 for highest/lowest questions unless the user asks for a top-N list.

Plan shape:
{"entity":"meme_cards","operation":"count","metric":null,"filters":{"season":1},"limit":1}

Entities:

- meme_cards
  Purpose: Public The Memes card stats.
  Operations:
    - count: count Meme Cards, metric should be null.
    - value: look up one metric for a specific Meme Card; requires filters.meme.
    - max: highest value for a metric.
    - min: lowest value for a metric.
    - sum: total value for metrics that can be summed.
    - avg: average value for metrics that can be averaged.
  Metrics:
    - tdh_rate: Meme Card TDH / HODL rate.
    - edition_size: Meme Card edition size.
    - supply: current NFT supply.
  Filters:
    - meme: Meme Card number, e.g. Meme #1 -> {"meme":1}.
    - season: The Memes season, e.g. SZN1 -> {"season":1}.
  Examples:
    - "how many memes are in szn1"
      -> {"entity":"meme_cards","operation":"count","metric":null,"filters":{"season":1},"limit":1}
    - "what is the tdh rate of meme #1"
      -> {"entity":"meme_cards","operation":"value","metric":"tdh_rate","filters":{"meme":1},"limit":1}
    - "what is the highest tdh rate"
      -> {"entity":"meme_cards","operation":"max","metric":"tdh_rate","filters":{},"limit":1}
    - "highest edition size in season 2"
      -> {"entity":"meme_cards","operation":"max","metric":"edition_size","filters":{"season":2},"limit":1}
    - "average edition size in szn1"
      -> {"entity":"meme_cards","operation":"avg","metric":"edition_size","filters":{"season":1},"limit":1}

- tdh_global
  Purpose: Latest public global TDH aggregate.
  Operations:
    - latest: latest global aggregate value.
    - value: same as latest for "current" wording.
  Metrics:
    - total_tdh: latest total boosted TDH.
  Filters: none.
  Examples:
    - "total tdh"
      -> {"entity":"tdh_global","operation":"latest","metric":"total_tdh","filters":{},"limit":1}
    - "what is the current total TDH"
      -> {"entity":"tdh_global","operation":"latest","metric":"total_tdh","filters":{},"limit":1}
`;
