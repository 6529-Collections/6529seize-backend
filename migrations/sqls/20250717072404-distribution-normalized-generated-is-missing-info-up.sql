ALTER TABLE distribution_normalized
ADD COLUMN is_missing_info TINYINT(1)
  GENERATED ALWAYS AS (
    card_name IS NULL OR card_name = '' OR mint_date IS NULL
  ) STORED;