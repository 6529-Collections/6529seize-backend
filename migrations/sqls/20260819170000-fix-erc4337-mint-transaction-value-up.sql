-- Discovery only advances into new blocks, so the code fix does not revisit
-- this existing row. Its stored eth_price_usd was populated by the same
-- historical-price lookup used during discovery and is required below.
UPDATE transactions
SET value = 0.06579,
    value_usd = 0.06579 * eth_price_usd
WHERE transaction = '0x87965828d5ed44d26b0244b93c7cee1caa1810c0bd513d7e0bb4a738e430d346'
  AND LOWER(contract) = '0x33fd426905f149f8376e227d0c9d3340aad17af1'
  AND token_id = 537
  AND LOWER(from_address) = '0x0000000000000000000000000000000000000000'
  AND LOWER(to_address) = '0xa88fe6fa01fcc112bb2164c6e37d63395b923e5f'
  AND token_count = 1
  AND value = 0
  AND primary_proceeds > 0
  AND eth_price_usd IS NOT NULL;
