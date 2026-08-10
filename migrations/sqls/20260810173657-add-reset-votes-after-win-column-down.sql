ALTER TABLE waves
  DROP COLUMN reset_votes_after_win,
  ALGORITHM=INPLACE,
  LOCK=NONE;

ALTER TABLE waves_archive
  DROP COLUMN reset_votes_after_win,
  ALGORITHM=INPLACE,
  LOCK=NONE;