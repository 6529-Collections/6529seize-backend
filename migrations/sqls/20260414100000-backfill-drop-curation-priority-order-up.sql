UPDATE drop_curations dc
JOIN (
  SELECT
    dc.drop_id,
    dc.curation_id,
    ROW_NUMBER() OVER (
      PARTITION BY dc.curation_id
      ORDER BY
        (d.created_at IS NULL) ASC,
        d.created_at ASC,
        dc.created_at ASC,
        dc.drop_id ASC
    ) AS priority_order
  FROM drop_curations dc
  LEFT JOIN drops d ON d.id = dc.drop_id
) ranked
  ON ranked.drop_id = dc.drop_id
 AND ranked.curation_id = dc.curation_id
SET dc.priority_order = ranked.priority_order;
