'use strict';

const TRUNCATED_CANDIDATE_EVIDENCE_STATUS =
  'PRODUCTION_CANDIDATE_EVIDENCE_QU';
const CANDIDATE_EVIDENCE_STATUS =
  'PRODUCTION_CANDIDATE_EVIDENCE_QUALIFIED';

exports.up = function (db) {
  return db
    .runSql(
      // The table is utf8mb4. Keep the widened column below the 255-byte
      // one-byte length-prefix boundary so MySQL can apply this online.
      'ALTER TABLE release_bus_v2_manifests MODIFY COLUMN status varchar(48) NOT NULL, ALGORITHM=INPLACE, LOCK=NONE'
    )
    .then(function () {
      return db.runSql(
        `UPDATE release_bus_v2_manifests
         SET status = '${CANDIDATE_EVIDENCE_STATUS}',
             updated_at = UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000
         WHERE status = '${TRUNCATED_CANDIDATE_EVIDENCE_STATUS}'
           AND JSON_UNQUOTE(JSON_EXTRACT(manifest_json, '$.scope')) =
             'production-candidate-evidence-qualification'
           AND JSON_UNQUOTE(JSON_EXTRACT(manifest_json, '$.qualification_policy')) =
             'CANDIDATE_STAGING_EVIDENCE_V1'`
      );
    })
    .then(function (result) {
      var repaired =
        result && Number.isInteger(result.affectedRows)
          ? result.affectedRows
          : 'unknown';
      console.info(
        `[release-bus-v2] repaired ${repaired} truncated candidate-evidence qualification manifest status row(s)`
      );
    });
};

exports.down = function () {
  // Intentionally non-destructive. Narrowing would truncate durable audit
  // state, and the widened column remains compatible with older workers.
  return Promise.resolve();
};

exports._meta = { version: 1 };
