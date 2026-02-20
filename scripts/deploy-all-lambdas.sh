# requires `gh` authenticated for the repo
# Make sure all actual lambdas are represented in SERVICES.
# If you want to deploy to staging then make sure you set the correct branch and environment!
SERVICES=(
  api
  aggregatedActivityLoop
  cloudwatchAlarmsToDiscordLoop
  claimsBuilder
  claimsMediaArweaveUploader
  customReplayLoop
  dbDumpsDaily
  dbMigrationsLoop
  delegationsLoop
  discoverEnsLoop
  dropVideoConversionInvokerLoop
  ethPriceLoop
  marketStatsLoop
  mediaResizerLoop
  nextgenContractLoop
  nextgenMediaImageResolutions
  nextgenMediaProxyInterceptor
  nextgenMediaUploader
  nextgenMetadataLoop
  nftHistoryLoop
  nftOwnersLoop
  nftsLoop
  overRatesRevocationLoop
  ownersBalancesLoop
  populateHistoricConsolidatedTdh
  pushNotificationsHandler
  rateEventProcessingLoop
  refreshEnsLoop
  rememesLoop
  royaltiesLoop
  s3Loop
  subscriptionsDaily
  subscriptionsTopUpLoop
  tdhHistoryLoop
  tdhLoop
  teamLoop
  transactionsLoop
  transactionsProcessingLoop
  waveDecisionExecutionLoop
  waveLeaderboardSnapshotterLoop
)

for s in "${SERVICES[@]}"; do
  gh workflow run "Deploy a service" \
    -f environment=prod \
    -f service="$s" \
    -R 6529-Collections/6529seize-backend
done
