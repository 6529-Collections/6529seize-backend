UPDATE memes_mint_stats mms
JOIN (
  SELECT
    mc.claim_id AS id,
    JSON_OBJECT(
      'payment_address',
      JSON_UNQUOTE(JSON_EXTRACT(dm.data_value, '$.payment_address')),
      'has_designated_payee',
      CASE
        WHEN JSON_EXTRACT(dm.data_value, '$.has_designated_payee') = TRUE THEN TRUE
        ELSE FALSE
      END,
      'designated_payee_name',
      COALESCE(
        JSON_UNQUOTE(JSON_EXTRACT(dm.data_value, '$.designated_payee_name')),
        ''
      )
    ) AS payment_details
  FROM minting_claims mc
  JOIN drops_metadatas dm
    ON dm.drop_id = mc.drop_id
   AND dm.data_key = 'payment_info'
  WHERE LOWER(mc.contract) = '0x33fd426905f149f8376e227d0c9d3340aad17af1'
    AND JSON_VALID(dm.data_value) = 1
    AND JSON_UNQUOTE(JSON_EXTRACT(dm.data_value, '$.payment_address')) IS NOT NULL
) payment_source
  ON payment_source.id = mms.id
SET mms.payment_details = payment_source.payment_details
WHERE mms.payment_details IS NULL;
