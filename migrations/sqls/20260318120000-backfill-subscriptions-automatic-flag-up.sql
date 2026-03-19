UPDATE subscriptions_nfts subscriptions
INNER JOIN (
  SELECT latest_subscription_actions.consolidation_key, latest_subscription_actions.token_id
  FROM (
    SELECT
      subscription_logs.consolidation_key,
      CAST(
        SUBSTRING_INDEX(
          SUBSTRING_INDEX(subscription_logs.log, 'Meme #', -1),
          ' ',
          1
        ) AS UNSIGNED
      ) AS token_id,
      subscription_logs.log,
      ROW_NUMBER() OVER (
        PARTITION BY
          subscription_logs.consolidation_key,
          CAST(
            SUBSTRING_INDEX(
              SUBSTRING_INDEX(subscription_logs.log, 'Meme #', -1),
              ' ',
              1
            ) AS UNSIGNED
          )
        ORDER BY subscription_logs.id DESC
      ) AS row_num
    FROM subscriptions_logs subscription_logs
    WHERE subscription_logs.log LIKE 'Auto-Subscribed to Meme #%'
       OR subscription_logs.log LIKE 'Subscribed for Meme #%'
       OR subscription_logs.log LIKE 'Subscribed to Meme #%'
       OR subscription_logs.log LIKE 'Unsubscribed from Meme #%'
       OR subscription_logs.log LIKE 'Updated subscription count for Meme #%'
  ) latest_subscription_actions
  WHERE latest_subscription_actions.row_num = 1
    AND latest_subscription_actions.log LIKE 'Auto-Subscribed to Meme #%'
) automatic_rows
  ON automatic_rows.consolidation_key = subscriptions.consolidation_key
 AND automatic_rows.token_id = subscriptions.token_id
SET subscriptions.automatic_subscription = TRUE;
