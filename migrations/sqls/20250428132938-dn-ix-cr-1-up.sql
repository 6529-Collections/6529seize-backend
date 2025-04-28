CREATE INDEX dn_cardname_contract_cardid_idx
    ON distribution_normalized (card_name(16), contract, card_id);