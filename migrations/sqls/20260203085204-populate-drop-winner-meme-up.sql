INSERT IGNORE INTO drop_winner_meme (drop_id, meme_id)
SELECT w.drop_id, (n.max_id - w.rn + 1) AS meme_id
FROM (
  SELECT drop_id, ROW_NUMBER() OVER (ORDER BY decision_time DESC) AS rn
  FROM wave_decision_winner_drops
  WHERE wave_id = '__MEMES_WAVE_ID__' AND ranking = 1
) w
CROSS JOIN (
  SELECT COALESCE(MAX(id), 0) AS max_id
  FROM nfts
  WHERE contract = '0x33FD426905F149f8376e227d0C9D3340AaD17aF1'
) n;
