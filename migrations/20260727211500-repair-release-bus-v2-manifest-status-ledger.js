'use strict';

const TRUNCATED_CANDIDATE_EVIDENCE_STATUS =
  'PRODUCTION_CANDIDATE_EVIDENCE_QU';

function affectedRows(result) {
  return result && Number.isInteger(result.affectedRows)
    ? result.affectedRows
    : 'unknown';
}

function repair(db, label, sql) {
  return db.runSql(sql).then(function (result) {
    console.info(
      `[release-bus-v2] restored ${affectedRows(result)} ${label} manifest status row(s)`
    );
  });
}

function selectRows(db, sql) {
  return new Promise(function (resolve, reject) {
    db.all(sql, function (error, rows) {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

function countedRows(result, column, purpose) {
  const value = Array.isArray(result) ? result[0]?.[column] : undefined;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0)
    throw new Error(
      `Release Bus v2 manifest status repair could not verify the ${purpose} row count`
    );
  return count;
}

exports.up = function (db) {
  // db-migrate-mysql wraps this migration in one transaction. This preflight
  // also rejects contradictory or unknown evidence before the first update.
  return selectRows(
    db,
      `SELECT COUNT(*) AS unclassified
       FROM release_bus_v2_manifests manifest
       WHERE manifest.status IN ('', '${TRUNCATED_CANDIDATE_EVIDENCE_STATUS}')
         AND NOT (
           (
             JSON_UNQUOTE(JSON_EXTRACT(manifest.manifest_json, '$.scope')) =
               'production-candidate-evidence-qualification'
             AND JSON_UNQUOTE(JSON_EXTRACT(manifest.manifest_json, '$.qualification_policy')) =
               'CANDIDATE_STAGING_EVIDENCE_V1'
           )
           OR (
             manifest.status = ''
             AND manifest.lane = 'PRODUCTION'
             AND JSON_UNQUOTE(JSON_EXTRACT(manifest.manifest_json, '$.scope')) =
               'production'
           )
           OR (
             manifest.status = ''
             AND manifest.lane IN ('STAGING', 'PRODUCTION_QUALIFICATION')
             AND JSON_UNQUOTE(JSON_EXTRACT(manifest.manifest_json, '$.scope')) =
               'staging'
             AND (
               (
                 manifest.validated_at IS NULL
                 AND EXISTS (
                   SELECT 1
                   FROM release_bus_v2_events failure_event
                   WHERE failure_event.train_id = manifest.train_id
                     AND failure_event.event_type IN (
                       'STAGING_FINAL_FENCE_MISSING',
                       'BETA_STAGING_FINAL_FENCE_MISSING',
                       'STAGING_FINAL_FENCE_VIOLATED',
                       'BETA_STAGING_FINAL_FENCE_VIOLATED',
                       'CUMULATIVE_STAGING_ROLLBACK_STARTED'
                     )
                 )
               )
               OR (
                 manifest.validated_at IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1
                   FROM release_bus_v2_events failure_event
                   WHERE failure_event.train_id = manifest.train_id
                     AND failure_event.event_type IN (
                       'STAGING_FINAL_FENCE_MISSING',
                       'BETA_STAGING_FINAL_FENCE_MISSING',
                       'STAGING_FINAL_FENCE_VIOLATED',
                       'BETA_STAGING_FINAL_FENCE_VIOLATED',
                       'CUMULATIVE_STAGING_ROLLBACK_STARTED'
                     )
                 )
               )
               OR (
                 manifest.validated_at IS NULL
                 AND EXISTS (
                   SELECT 1
                   FROM release_bus_v2_events deployed_event
                   WHERE deployed_event.train_id = manifest.train_id
                     AND deployed_event.event_type = 'TRAIN_STAGING_DEPLOYED'
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM release_bus_v2_events failure_event
                   WHERE failure_event.train_id = manifest.train_id
                     AND failure_event.event_type IN (
                       'STAGING_FINAL_FENCE_MISSING',
                       'BETA_STAGING_FINAL_FENCE_MISSING',
                       'STAGING_FINAL_FENCE_VIOLATED',
                       'BETA_STAGING_FINAL_FENCE_VIOLATED',
                       'CUMULATIVE_STAGING_ROLLBACK_STARTED'
                     )
                 )
               )
             )
           )
         )`
  )
    .then(function (result) {
      const unclassified = countedRows(
        result,
        'unclassified',
        'preflight unclassified'
      );
      console.info(
        `[release-bus-v2] manifest status ledger repair found ${unclassified} unclassified row(s) before mutation`
      );
      if (unclassified !== 0)
        throw new Error(
          `Release Bus v2 manifest status repair found ${unclassified} unclassified row(s) before mutation`
        );
    })
    .then(function () {
      return repair(
        db,
        'candidate-evidence qualification',
        `UPDATE release_bus_v2_manifests
     SET status = 'PRODUCTION_CANDIDATE_EVIDENCE_QUALIFIED',
         updated_at = UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000
     WHERE status IN ('', '${TRUNCATED_CANDIDATE_EVIDENCE_STATUS}')
       AND JSON_UNQUOTE(JSON_EXTRACT(manifest_json, '$.scope')) =
         'production-candidate-evidence-qualification'
       AND JSON_UNQUOTE(JSON_EXTRACT(manifest_json, '$.qualification_policy')) =
         'CANDIDATE_STAGING_EVIDENCE_V1'`
      );
    })
    .then(function () {
      return repair(
        db,
        'production-deployed',
        `UPDATE release_bus_v2_manifests
         SET status = 'PRODUCTION_DEPLOYED',
             updated_at = UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000
         WHERE status = ''
           AND lane = 'PRODUCTION'
           AND JSON_UNQUOTE(JSON_EXTRACT(manifest_json, '$.scope')) =
             'production'`
      );
    })
    .then(function () {
      return repair(
        db,
        'failed staging',
        `UPDATE release_bus_v2_manifests manifest
         SET manifest.status = 'FAILED',
             manifest.updated_at = UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000
         WHERE manifest.status = ''
           AND manifest.lane IN ('STAGING', 'PRODUCTION_QUALIFICATION')
           AND manifest.validated_at IS NULL
           AND JSON_UNQUOTE(JSON_EXTRACT(manifest.manifest_json, '$.scope')) =
             'staging'
           AND EXISTS (
             SELECT 1
             FROM release_bus_v2_events event
             WHERE event.train_id = manifest.train_id
               AND event.event_type IN (
                 'STAGING_FINAL_FENCE_MISSING',
                 'BETA_STAGING_FINAL_FENCE_MISSING',
                 'STAGING_FINAL_FENCE_VIOLATED',
                 'BETA_STAGING_FINAL_FENCE_VIOLATED',
                 'CUMULATIVE_STAGING_ROLLBACK_STARTED'
               )
           )`
      );
    })
    .then(function () {
      return repair(
        db,
        'staging-validated',
        `UPDATE release_bus_v2_manifests
         SET status = 'STAGING_VALIDATED',
             updated_at = UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000
         WHERE status = ''
           AND lane IN ('STAGING', 'PRODUCTION_QUALIFICATION')
           AND validated_at IS NOT NULL
           AND JSON_UNQUOTE(JSON_EXTRACT(manifest_json, '$.scope')) =
             'staging'
           AND NOT EXISTS (
             SELECT 1
             FROM release_bus_v2_events event
             WHERE event.train_id = release_bus_v2_manifests.train_id
               AND event.event_type IN (
                 'STAGING_FINAL_FENCE_MISSING',
                 'BETA_STAGING_FINAL_FENCE_MISSING',
                 'STAGING_FINAL_FENCE_VIOLATED',
                 'BETA_STAGING_FINAL_FENCE_VIOLATED',
                 'CUMULATIVE_STAGING_ROLLBACK_STARTED'
               )
           )`
      );
    })
    .then(function () {
      return repair(
        db,
        'staging-deployed',
        `UPDATE release_bus_v2_manifests manifest
         SET manifest.status = 'STAGING_DEPLOYED',
             manifest.updated_at = UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000
         WHERE manifest.status = ''
           AND manifest.lane IN ('STAGING', 'PRODUCTION_QUALIFICATION')
           AND manifest.validated_at IS NULL
           AND JSON_UNQUOTE(JSON_EXTRACT(manifest.manifest_json, '$.scope')) =
             'staging'
           AND EXISTS (
             SELECT 1
             FROM release_bus_v2_events event
             WHERE event.train_id = manifest.train_id
               AND event.event_type = 'TRAIN_STAGING_DEPLOYED'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM release_bus_v2_events failure_event
             WHERE failure_event.train_id = manifest.train_id
               AND failure_event.event_type IN (
                 'STAGING_FINAL_FENCE_MISSING',
                 'BETA_STAGING_FINAL_FENCE_MISSING',
                 'STAGING_FINAL_FENCE_VIOLATED',
                 'BETA_STAGING_FINAL_FENCE_VIOLATED',
                 'CUMULATIVE_STAGING_ROLLBACK_STARTED'
               )
           )`
      );
    })
    .then(function () {
      return selectRows(
        db,
        `SELECT COUNT(*) AS remaining
         FROM release_bus_v2_manifests
         WHERE status = ''
            OR status = '${TRUNCATED_CANDIDATE_EVIDENCE_STATUS}'`
      );
    })
    .then(function (result) {
      const remaining = countedRows(
        result,
        'remaining',
        'remaining invalid'
      );
      console.info(
        `[release-bus-v2] manifest status ledger repair left ${remaining} invalid row(s)`
      );
      if (remaining !== 0)
        throw new Error(
          `Release Bus v2 manifest status repair left ${remaining} unclassified row(s)`
        );
    });
};

exports.down = function () {
  // Intentionally non-destructive. Restored immutable lifecycle status must
  // survive an application rollback.
  return Promise.resolve();
};

exports._meta = { version: 1 };
