ALTER TABLE waves
  DROP COLUMN reset_votes_after_win,
  ALGORITHM=INPLACE,
  LOCK=NONE;