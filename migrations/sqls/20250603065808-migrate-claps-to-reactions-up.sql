INSERT INTO drop_reactions (
  profile_id,
  wave_id,
  drop_id,
  reaction
)
SELECT
  dcs.clapper_id   AS profile_id,
  dcs.wave_id      AS wave_id,
  dcs.drop_id      AS drop_id,
  CASE
    WHEN dcs.claps > 0 THEN ':+1:'
    ELSE ':-1:'
  END               AS reaction
FROM
  drop_clapper_states AS dcs
WHERE
  dcs.claps <> 0
;