update nft_links
set price_currency = 'ETH'
where price is not null
  and (
    price_currency is null
    or trim(price_currency) = ''
  );
