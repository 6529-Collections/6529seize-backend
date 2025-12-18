INSERT INTO wave_outcomes (
    wave_id,
    wave_outcome_position,
    type,
    subtype,
    description,
    credit,
    rep_category,
    amount
)
SELECT
    w.id AS wave_id,
    o.wave_outcome_position,
    o.type,
    o.subtype,
    o.description,
    o.credit,
    o.rep_category,
    o.amount
FROM waves w
         JOIN JSON_TABLE(
        w.outcomes,
        '$[*]' COLUMNS (
            wave_outcome_position FOR ORDINALITY,
            type        VARCHAR(20) PATH '$.type',
            subtype     VARCHAR(20) PATH '$.subtype'      NULL ON EMPTY,
            description TEXT        PATH '$.description'  NULL ON EMPTY,
            credit      VARCHAR(20) PATH '$.credit'       NULL ON EMPTY,
            rep_category TEXT       PATH '$.rep_category' NULL ON EMPTY,
            amount      BIGINT      PATH '$.amount'       NULL ON EMPTY
            )
              ) AS o
WHERE JSON_LENGTH(w.outcomes) > 0 and w.id not in (select wave_id from wave_outcomes);