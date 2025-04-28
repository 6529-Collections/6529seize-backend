CREATE INDEX dn_mintdate_contract_cardid_idx
    ON distribution_normalized (mint_date, contract, card_id);