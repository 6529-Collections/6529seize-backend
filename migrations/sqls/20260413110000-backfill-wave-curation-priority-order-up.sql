UPDATE wave_curation_groups wc
JOIN (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY wave_id
      ORDER BY created_at ASC, id ASC
    ) AS priority_order
  FROM wave_curation_groups
) ranked ON ranked.id = wc.id
SET wc.priority_order = ranked.priority_order;
