ALTER TABLE eula_consent
  ADD COLUMN eula_version varchar(32) NULL AFTER platform,
  ALGORITHM=INPLACE,
  LOCK=NONE;
