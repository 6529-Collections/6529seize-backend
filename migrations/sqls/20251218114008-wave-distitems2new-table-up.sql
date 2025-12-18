INSERT INTO wave_outcome_distribution_items (
    wave_id,
    wave_outcome_position,
    wave_outcome_distribution_item_position,
    amount,
    description
)
SELECT
    w.id AS wave_id,
    o.wave_outcome_position,
    d.wave_outcome_distribution_item_position,
    d.amount,
    d.description
FROM waves w
         JOIN JSON_TABLE(
        w.outcomes,
        '$[*]' COLUMNS (
            wave_outcome_position FOR ORDINALITY,
            distribution JSON PATH '$.distribution' NULL ON EMPTY
            )
              ) AS o
         JOIN JSON_TABLE(
        o.distribution,
        '$[*]' COLUMNS (
            wave_outcome_distribution_item_position FOR ORDINALITY,
            amount      BIGINT PATH '$.amount'       NULL ON EMPTY,
            description TEXT   PATH '$.description'  NULL ON EMPTY
            )
              ) AS d
WHERE JSON_TYPE(o.distribution) = 'ARRAY'
  AND JSON_LENGTH(o.distribution) > 0 and w.id not in (select wave_id from wave_outcome_distribution_items);