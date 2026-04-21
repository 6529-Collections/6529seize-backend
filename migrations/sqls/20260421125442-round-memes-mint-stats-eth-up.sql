UPDATE memes_mint_stats
SET
  proceeds_eth = ROUND(proceeds_eth, 10),
  artist_split_eth = ROUND(artist_split_eth, 10);
