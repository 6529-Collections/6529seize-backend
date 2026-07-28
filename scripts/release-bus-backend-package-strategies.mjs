export const RELEASE_BUS_BACKEND_INSTALL_STRATEGIES = Object.freeze({
  api: 'local-frozen',
  aggregatedActivityLoop: 'root-bundled',
  attachmentsOrchestrator: 'local-frozen',
  attachmentsProcessor: 'local-frozen',
  artCurationNftWatchLoop: 'local-frozen',
  cloudwatchAlarmsToDiscordLoop: 'root-bundled',
  claimsBuilder: 'root-bundled',
  claimsMediaArweaveUploader: 'local-frozen',
  customReplayLoop: 'root-bundled',
  dbDumpsDaily: 'root-bundled',
  dbMigrationsLoop: 'local-frozen',
  delegationsLoop: 'root-bundled',
  discoverEnsLoop: 'root-bundled',
  dropMediaIngestStorage: 'root-bundled',
  dropMediaSanitizer: 'self-install-native',
  dropVideoConversionInvokerLoop: 'root-bundled',
  ethPriceLoop: 'root-bundled',
  externalCollectionLiveTailingLoop: 'root-bundled',
  externalCollectionSnapshottingLoop: 'root-bundled',
  helpBotReplyLoop: 'root-bundled',
  marketStatsLoop: 'root-bundled',
  mediaResizerLoop: 'self-install-native',
  mintAnnouncementsLoop: 'root-bundled',
  nextgenContractLoop: 'root-bundled',
  nextgenMediaImageResolutions: 'root-bundled',
  nextgenMediaProxyInterceptor: 'root-bundled',
  nextgenMediaUploader: 'root-bundled',
  nextgenMetadataLoop: 'root-bundled',
  nftHistoryLoop: 'root-bundled',
  nftLinkRefresherLoop: 'root-bundled',
  nftLinkMediaPreviewLoop: 'self-install-native',
  nftOwnersLoop: 'root-bundled',
  nftsLoop: 'root-bundled',
  overRatesRevocationLoop: 'root-bundled',
  ownersBalancesLoop: 'root-bundled',
  populateHistoricConsolidatedTdh: 'local-frozen',
  pushNotificationsHandler: 'root-bundled',
  rateEventProcessingLoop: 'root-bundled',
  releaseBus: 'root-bundled',
  releaseNotesGenerationLoop: 'root-bundled',
  refreshEnsLoop: 'root-bundled',
  rememesLoop: 'local-frozen',
  royaltiesLoop: 'root-bundled',
  s3Uploader: 'local-frozen',
  subscriptionsDaily: 'root-bundled',
  subscriptionsTopUpLoop: 'root-bundled',
  xTdhGrantsReviewerLoop: 'root-bundled',
  tdhHistoryLoop: 'local-frozen',
  tdhLoop: 'local-frozen',
  teamLoop: 'root-bundled',
  transactionsLoop: 'local-frozen',
  transactionsProcessingLoop: 'root-bundled',
  waveDecisionExecutionLoop: 'root-bundled',
  waveLeaderboardSnapshotterLoop: 'local-frozen',
  waveDropMetricsRefreshLoop: 'local-frozen',
  waveScoreRefreshLoop: 'local-frozen',
  xTdhLoop: 'root-bundled'
});

export function validateReleaseBusBackendInstallStrategyCoverage(serviceNames) {
  const configured = [...serviceNames].sort((left, right) =>
    left.localeCompare(right)
  );
  const categorized = Object.keys(RELEASE_BUS_BACKEND_INSTALL_STRATEGIES).sort(
    (left, right) => left.localeCompare(right)
  );
  if (
    configured.length !== categorized.length ||
    configured.some((name, index) => name !== categorized[index])
  )
    throw new Error(
      'Every backend deploy unit must have one explicit Release Bus install strategy'
    );
}

export function validateReleaseBusBackendLayers(units, layers) {
  const flattenedLayers = Array.isArray(layers) ? layers.flat() : [];
  if (
    !Array.isArray(units) ||
    units.length === 0 ||
    new Set(units).size !== units.length ||
    units.some((unit) => typeof unit !== 'string') ||
    !Array.isArray(layers) ||
    layers.length === 0 ||
    layers.some(
      (layer) =>
        !Array.isArray(layer) ||
        layer.length === 0 ||
        new Set(layer).size !== layer.length ||
        layer.some((unit) => typeof unit !== 'string')
    ) ||
    flattenedLayers.length !== units.length ||
    new Set(flattenedLayers).size !== units.length ||
    [...flattenedLayers].sort().join('\n') !== [...units].sort().join('\n')
  )
    throw new Error(
      'layers-json must partition the selected units into dependency frontiers'
    );
  return layers;
}
