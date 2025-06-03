DELETE dr
FROM
  drop_reactions AS dr
  JOIN drop_clapper_states AS dcs
    ON dr.profile_id = dcs.clapper_id
   AND dr.wave_id    = dcs.wave_id
   AND dr.drop_id    = dcs.drop_id
WHERE
  (dcs.claps > 0 AND dr.reaction = ':+1:')
  OR
  (dcs.claps < 0 AND dr.reaction = ':-1:')
;