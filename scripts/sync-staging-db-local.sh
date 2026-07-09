#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/sync-staging-db-local.sh --yes
  bash scripts/sync-staging-db-local.sh --fresh --yes
  bash scripts/sync-staging-db-local.sh --dump-only
  bash scripts/sync-staging-db-local.sh --restore-only --yes

Purpose:
  Build a restartable staging MySQL dump locally, then replace the local Docker
  MySQL database with that dump.

Important consistency note:
  This script is reliable/resumable, not a strict single point-in-time snapshot.
  Each table/chunk is dumped with --single-transaction, but retries happen in
  later transactions. For a perfect point-in-time staging clone, use an RDS
  snapshot or run one uninterrupted mysqldump inside AWS.

Required env file:
  .env.staging-db.local

Required variables:
  STAGING_DB_NAME
  STAGING_DB_USER_READ
  STAGING_DB_PASS_READ

Connection variables:
  STAGING_DB_TUNNEL_HOST        default: 127.0.0.1
  STAGING_DB_TUNNEL_PORT        default: 3307

Optional automatic SSM tunnel variables:
  STAGING_SSM_TARGET            example: i-059d5adda6cc33b90
  STAGING_AWS_REGION            default: eu-west-1
  STAGING_DB_HOST_READ          RDS host used by the SSM tunnel
  STAGING_DB_PORT               default: 3306

Local restore variables:
  LOCAL_DB_NAME                 default: OM6529
  LOCAL_DB_SERVICE              default: mysql
  LOCAL_DB_ROOT_USER            default: root
  LOCAL_DB_ROOT_PASS            default: password
  AUTO_START_DOCKER             default: true
  DOCKER_READY_TIMEOUT_SECONDS  default: 300

Reliability tuning:
  DUMP_DIR                      default: .staging-db-dump/current
  DUMP_MAX_ATTEMPTS             default: 0 (unlimited)
  RETRY_SLEEP_SECONDS           default: 30
  CHUNK_TABLE_MIN_MB            default: 512
  CHUNK_RANGE_SIZE              default: 500000
  CHUNK_COLUMN_OVERRIDES        default: historic_tdh_consolidation:block:distinct;tdh:block:distinct;tdh_history:block:distinct

Fresh mode:
  --fresh archives DUMP_DIR before starting, builds a new dump in the same
  location, and removes the archived old dump only after the run succeeds.

Schema drift handling:
  Dump/resume mode refreshes the schema before table dumps. If table columns
  changed since the previous schema, only affected table dump files are moved
  aside and re-dumped. Restore-only mode never contacts staging.

Examples:
  # Full dump, then replace local OM6529 after dump validation.
  bash scripts/sync-staging-db-local.sh --yes

  # New full dump, then replace local OM6529 after dump validation.
  bash scripts/sync-staging-db-local.sh --fresh --yes

  # Only fetch/update dump parts. Does not touch local DB.
  bash scripts/sync-staging-db-local.sh --dump-only

  # Import already completed dump parts into local Docker MySQL.
  bash scripts/sync-staging-db-local.sh --restore-only --yes
USAGE
}

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

find_mysql_client() {
  local binary_name="$1"
  local explicit_var="$2"
  local explicit_path="${!explicit_var:-}"

  if [[ -n "$explicit_path" ]]; then
    [[ -x "$explicit_path" ]] || die "$explicit_var is not executable: $explicit_path"
    printf '%s\n' "$explicit_path"
    return
  fi

  if command -v "$binary_name" >/dev/null 2>&1; then
    command -v "$binary_name"
    return
  fi

  for candidate in \
    "/opt/homebrew/opt/mysql-client/bin/$binary_name" \
    "/usr/local/opt/mysql-client/bin/$binary_name"
  do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  die "Missing $binary_name. Install mysql-client or set ${explicit_var}."
}

sql_string_literal() {
  local value="$1"
  value="${value//\'/\'\'}"
  printf "'%s'" "$value"
}

sql_identifier() {
  local value="$1"
  value="${value//\`/\`\`}"
  printf '`%s`' "$value"
}

safe_file_name() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '_'
}

parse_args() {
  MODE="sync"
  YES="false"
  FRESH_DUMP="false"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --fresh)
        FRESH_DUMP="true"
        ;;
      --dump-only)
        MODE="dump"
        ;;
      --restore-only)
        MODE="restore"
        ;;
      --yes)
        YES="true"
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        die "Unknown argument: $1"
        ;;
    esac
    shift
  done
}

load_config() {
  ENV_FILE="${ENV_FILE:-.env.staging-db.local}"
  [[ -f "$ENV_FILE" ]] || die "Missing $ENV_FILE"

  # shellcheck disable=SC1090
  source "$ENV_FILE"

  : "${STAGING_DB_NAME:?Missing STAGING_DB_NAME in $ENV_FILE}"
  : "${STAGING_DB_USER_READ:?Missing STAGING_DB_USER_READ in $ENV_FILE}"
  : "${STAGING_DB_PASS_READ:?Missing STAGING_DB_PASS_READ in $ENV_FILE}"

  STAGING_DB_TUNNEL_HOST="${STAGING_DB_TUNNEL_HOST:-127.0.0.1}"
  STAGING_DB_TUNNEL_PORT="${STAGING_DB_TUNNEL_PORT:-3307}"
  STAGING_AWS_REGION="${STAGING_AWS_REGION:-eu-west-1}"
  STAGING_DB_PORT="${STAGING_DB_PORT:-3306}"

  LOCAL_DB_NAME="${LOCAL_DB_NAME:-OM6529}"
  LOCAL_DB_SERVICE="${LOCAL_DB_SERVICE:-mysql}"
  LOCAL_DB_ROOT_USER="${LOCAL_DB_ROOT_USER:-root}"
  LOCAL_DB_ROOT_PASS="${LOCAL_DB_ROOT_PASS:-password}"
  AUTO_START_DOCKER="${AUTO_START_DOCKER:-true}"
  DOCKER_READY_TIMEOUT_SECONDS="${DOCKER_READY_TIMEOUT_SECONDS:-300}"

  DUMP_DIR="${DUMP_DIR:-.staging-db-dump/current}"
  DUMP_MAX_ATTEMPTS="${DUMP_MAX_ATTEMPTS:-0}"
  RETRY_SLEEP_SECONDS="${RETRY_SLEEP_SECONDS:-30}"
  CHUNK_TABLE_MIN_MB="${CHUNK_TABLE_MIN_MB:-512}"
  CHUNK_RANGE_SIZE="${CHUNK_RANGE_SIZE:-500000}"
  CHUNK_COLUMN_OVERRIDES="${CHUNK_COLUMN_OVERRIDES:-historic_tdh_consolidation:block:distinct;tdh:block:distinct;tdh_history:block:distinct}"

  CHUNK_TABLE_MIN_BYTES=$((CHUNK_TABLE_MIN_MB * 1024 * 1024))

  if [[ "$YES" == "true" ]]; then
    CONFIRM_REPLACE_LOCAL_DB="$LOCAL_DB_NAME"
  else
    CONFIRM_REPLACE_LOCAL_DB="${CONFIRM_REPLACE_LOCAL_DB:-}"
  fi
}

prepare_fresh_dump_dir() {
  [[ "$FRESH_DUMP" == "true" ]] || return 0

  if [[ "$MODE" == "restore" ]]; then
    die "--fresh cannot be used with --restore-only"
  fi

  if [[ ! -e "$DUMP_DIR" ]]; then
    log "Fresh sync requested; no existing dump directory to archive"
    return 0
  fi

  local dump_parent dump_base archive_root archive_name
  dump_parent="$(dirname "$DUMP_DIR")"
  dump_base="$(basename "$DUMP_DIR")"
  archive_root="${DUMP_ARCHIVE_DIR:-$dump_parent/archive}"
  archive_name="${dump_base}-$(date '+%Y%m%d-%H%M%S')-$$"
  FRESH_ARCHIVE_DIR="$archive_root/$archive_name"

  mkdir -p "$archive_root"
  mv "$DUMP_DIR" "$FRESH_ARCHIVE_DIR"
  log "Fresh sync requested; archived previous dump at $FRESH_ARCHIVE_DIR"
}

prepare_workspace() {
  umask 077
  mkdir -p "$DUMP_DIR/tables" "$DUMP_DIR/logs"

  MYSQL_BIN="$(find_mysql_client mysql MYSQL_BIN)"
  MYSQLDUMP_BIN="$(find_mysql_client mysqldump MYSQLDUMP_BIN)"
  require_cmd gzip
  require_cmd gunzip
  require_cmd docker

  STAGING_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/staging-db-client.XXXXXX")"
  STAGING_CNF="$STAGING_TMP_DIR/staging-db-client.cnf"
  {
    printf '[client]\n'
    printf 'host=%s\n' "$STAGING_DB_TUNNEL_HOST"
    printf 'port=%s\n' "$STAGING_DB_TUNNEL_PORT"
    printf 'user=%s\n' "$STAGING_DB_USER_READ"
    printf 'password=%s\n' "$STAGING_DB_PASS_READ"
    printf 'protocol=TCP\n'
  } > "$STAGING_CNF"
  chmod 600 "$STAGING_CNF"
}

cleanup() {
  local exit_code=$?
  [[ -n "${STAGING_CNF:-}" ]] && rm -f "$STAGING_CNF"
  [[ -n "${STAGING_TMP_DIR:-}" ]] && rm -rf "$STAGING_TMP_DIR"
  if [[ -n "${SSM_PID:-}" ]] && kill -0 "$SSM_PID" >/dev/null 2>&1; then
    kill "$SSM_PID" >/dev/null 2>&1 || true
  fi

  if [[ "$exit_code" -eq 0 && -n "${FRESH_ARCHIVE_DIR:-}" && -d "$FRESH_ARCHIVE_DIR" ]]; then
    log "Fresh sync succeeded; removing previous dump archive $FRESH_ARCHIVE_DIR"
    rm -rf "$FRESH_ARCHIVE_DIR"
  fi

  exit "$exit_code"
}

port_is_open() {
  if command -v nc >/dev/null 2>&1; then
    nc -z "$STAGING_DB_TUNNEL_HOST" "$STAGING_DB_TUNNEL_PORT" >/dev/null 2>&1
    return
  fi

  "$MYSQL_BIN" --defaults-extra-file="$STAGING_CNF" \
    --connect-timeout=2 \
    --batch \
    --skip-column-names \
    -e 'SELECT 1' >/dev/null 2>&1
}

start_ssm_tunnel_if_configured() {
  [[ -n "${STAGING_SSM_TARGET:-}" ]] || return 0

  if port_is_open; then
    return 0
  fi

  : "${STAGING_DB_HOST_READ:?STAGING_DB_HOST_READ is required when STAGING_SSM_TARGET is set}"
  require_cmd aws
  require_cmd session-manager-plugin

  if [[ -n "${SSM_PID:-}" ]] && kill -0 "$SSM_PID" >/dev/null 2>&1; then
    kill "$SSM_PID" >/dev/null 2>&1 || true
  fi

  local tunnel_log="$DUMP_DIR/logs/ssm-tunnel.log"
  log "Starting SSM tunnel on ${STAGING_DB_TUNNEL_HOST}:${STAGING_DB_TUNNEL_PORT} -> ${STAGING_DB_HOST_READ}:${STAGING_DB_PORT}"
  aws ssm start-session \
    --region "$STAGING_AWS_REGION" \
    --target "$STAGING_SSM_TARGET" \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters "{\"host\":[\"$STAGING_DB_HOST_READ\"],\"portNumber\":[\"$STAGING_DB_PORT\"],\"localPortNumber\":[\"$STAGING_DB_TUNNEL_PORT\"]}" \
    > "$tunnel_log" 2>&1 &
  SSM_PID=$!

  local waited=0
  while [[ "$waited" -lt 60 ]]; do
    if port_is_open; then
      log "SSM tunnel is ready"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  die "SSM tunnel did not become ready. See $tunnel_log"
}

mysql_staging() {
  start_ssm_tunnel_if_configured
  "$MYSQL_BIN" --defaults-extra-file="$STAGING_CNF" \
    --connect-timeout=10 \
    --batch \
    --raw \
    --skip-column-names \
    "$@"
}

mysqldump_staging() {
  start_ssm_tunnel_if_configured
  "$MYSQLDUMP_BIN" \
    --defaults-extra-file="$STAGING_CNF" \
    --compress \
    --network-timeout \
    --max-allowed-packet=1073741824 \
    "$@"
}

run_with_retries() {
  local description="$1"
  shift
  local attempt=1
  local exit_code=0

  while true; do
    log "$description (attempt $attempt)"
    if "$@"; then
      return 0
    else
      exit_code=$?
    fi

    if [[ "$DUMP_MAX_ATTEMPTS" != "0" && "$attempt" -ge "$DUMP_MAX_ATTEMPTS" ]]; then
      log "$description failed after $attempt attempts"
      return "$exit_code"
    fi

    log "$description failed with exit $exit_code; retrying in ${RETRY_SLEEP_SECONDS}s"
    sleep "$RETRY_SLEEP_SECONDS"
    attempt=$((attempt + 1))
  done
}

validated_gzip_exists() {
  local file="$1"
  [[ -s "$file" ]] && gzip -t "$file" >/dev/null 2>&1
}

atomic_gzip_dump() {
  local final_file="$1"
  shift
  local tmp_file="${final_file}.tmp"

  rm -f "$tmp_file"
  if ! "$@" | gzip -c > "$tmp_file"; then
    rm -f "$tmp_file"
    return 1
  fi
  if ! gzip -t "$tmp_file"; then
    rm -f "$tmp_file"
    return 1
  fi
  mv "$tmp_file" "$final_file"
}

schema_columns_from_dump() {
  local dump_file="$1"
  local output_file="$2"

  gunzip -c "$dump_file" | awk '
    /^CREATE TABLE `/ {
      table = $0
      sub(/^CREATE TABLE `/, "", table)
      sub(/`.*/, "", table)
      columns = ""
      next
    }

    table != "" && /^\) ENGINE=/ {
      print table "\t" columns
      table = ""
      columns = ""
      next
    }

    table != "" && /^  `/ {
      column = $0
      sub(/^  `/, "", column)
      sub(/`.*/, "", column)
      columns = columns (columns == "" ? "" : ",") column
    }
  ' > "$output_file"
}

move_to_stale_dir() {
  local stale_dir="$1"
  local path="$2"

  [[ -e "$path" ]] || return 0
  mkdir -p "$stale_dir"
  mv "$path" "$stale_dir/$(basename "$path")"
}

invalidate_table_dump() {
  local table="$1"
  local stale_dir="$2"
  local safe_table whole_file chunk_dir done_file

  safe_table="$(safe_file_name "$table")"
  whole_file="$DUMP_DIR/tables/${safe_table}.sql.gz"
  chunk_dir="$DUMP_DIR/tables/${safe_table}"
  done_file="$DUMP_DIR/tables/${safe_table}.chunks.done"

  move_to_stale_dir "$stale_dir" "$whole_file"
  move_to_stale_dir "$stale_dir" "${whole_file}.tmp"
  move_to_stale_dir "$stale_dir" "$chunk_dir"
  move_to_stale_dir "$stale_dir" "$done_file"
}

invalidate_schema_changed_tables() {
  local previous_columns_file="$1"
  local current_columns_file="$2"
  local changed_tables_file="$DUMP_DIR/schema.changed-tables.tsv"
  local stale_dir="$DUMP_DIR/stale/schema-$(date '+%Y%m%d-%H%M%S')-$$"
  local changed_count table

  awk -F '\t' '
    NR == FNR {
      previous[$1] = $2
      previous_seen[$1] = 1
      next
    }

    {
      current_seen[$1] = 1
      if (!( $1 in previous ) || previous[$1] != $2) {
        print $1
      }
    }

    END {
      for (table in previous_seen) {
        if (!( table in current_seen )) {
          print table
        }
      }
    }
  ' "$previous_columns_file" "$current_columns_file" | sort > "${changed_tables_file}.tmp"
  mv "${changed_tables_file}.tmp" "$changed_tables_file"

  if [[ ! -s "$changed_tables_file" ]]; then
    log "Schema refreshed; table columns are unchanged"
    return 0
  fi

  changed_count="$(wc -l < "$changed_tables_file" | tr -d ' ')"
  log "Schema column changes detected for $changed_count table(s); invalidating only those dumps"

  while IFS=$'\t' read -r table; do
    [[ -n "$table" ]] || continue
    log "Invalidating stale dump for schema-changed table $table"
    invalidate_table_dump "$table" "$stale_dir"
  done < "$changed_tables_file"

  rm -f "$DUMP_DIR/dump.complete"
}

dump_schema_once() {
  local final_file="$DUMP_DIR/schema.sql.gz"
  local current_file="$DUMP_DIR/schema.current.sql.gz"
  local previous_file="$DUMP_DIR/schema.previous.sql.gz"
  local current_columns_file="$DUMP_DIR/schema.current.columns.tsv"
  local previous_columns_file="$DUMP_DIR/schema.previous.columns.tsv"
  local final_columns_file="$DUMP_DIR/schema.columns.tsv"
  local compare_file=""

  if validated_gzip_exists "$final_file"; then
    compare_file="$final_file"
  elif validated_gzip_exists "${final_file}.stale"; then
    compare_file="${final_file}.stale"
  fi

  rm -f "$current_file" "$current_columns_file"

  atomic_gzip_dump "$current_file" \
    mysqldump_staging \
      --single-transaction \
      --routines \
      --triggers \
      --events \
      --no-data \
      --default-character-set=utf8mb4 \
      --set-gtid-purged=OFF \
      --no-tablespaces \
      "$STAGING_DB_NAME"

  schema_columns_from_dump "$current_file" "$current_columns_file"

  if [[ -n "$compare_file" ]]; then
    schema_columns_from_dump "$compare_file" "${previous_columns_file}.tmp"
    mv "${previous_columns_file}.tmp" "$previous_columns_file"
    invalidate_schema_changed_tables "$previous_columns_file" "$current_columns_file"

    if [[ "$compare_file" == "$final_file" && ! -f "$previous_file" ]]; then
      cp "$final_file" "$previous_file"
    fi
  else
    log "No previous schema dump found; current schema will be used"
  fi

  if [[ -f "$final_file" ]] && cmp -s "$final_file" "$current_file"; then
    log "Schema dump already matches staging"
    rm -f "$current_file"
  else
    [[ -f "$final_file" ]] && cp "$final_file" "$previous_file"
    mv "$current_file" "$final_file"
    log "Schema dump refreshed"
  fi

  mv "$current_columns_file" "$final_columns_file"
}

dump_schema() {
  run_with_retries "Dump schema" dump_schema_once
}

table_list_query() {
  local schema_literal
  schema_literal="$(sql_string_literal "$STAGING_DB_NAME")"
  printf 'SELECT table_name FROM information_schema.tables WHERE table_schema = %s AND table_type = '\''BASE TABLE'\'' ORDER BY table_name;' "$schema_literal"
}

write_table_list_once() {
  local table_file="$DUMP_DIR/tables.tsv"
  mysql_staging -e "$(table_list_query)" > "$table_file.tmp"
  mv "$table_file.tmp" "$table_file"
}

write_table_list() {
  run_with_retries "Read staging table list" write_table_list_once
}

table_data_bytes() {
  local table="$1"
  local schema_literal table_literal
  schema_literal="$(sql_string_literal "$STAGING_DB_NAME")"
  table_literal="$(sql_string_literal "$table")"
  mysql_staging -e "SELECT COALESCE(data_length, 0) FROM information_schema.tables WHERE table_schema = $schema_literal AND table_name = $table_literal;"
}

single_numeric_primary_key() {
  local table="$1"
  local schema_literal table_literal
  schema_literal="$(sql_string_literal "$STAGING_DB_NAME")"
  table_literal="$(sql_string_literal "$table")"
  mysql_staging -e "
    SELECT COALESCE(MAX(c.column_name), '')
    FROM information_schema.key_column_usage k
    JOIN information_schema.columns c
      ON c.table_schema = k.table_schema
     AND c.table_name = k.table_name
     AND c.column_name = k.column_name
    WHERE k.table_schema = $schema_literal
      AND k.table_name = $table_literal
      AND k.constraint_name = 'PRIMARY'
    GROUP BY k.table_schema, k.table_name
    HAVING COUNT(*) = 1
       AND MAX(c.data_type IN ('tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint')) = 1;
  " | head -n 1
}

numeric_column_exists() {
  local table="$1"
  local column="$2"
  local schema_literal table_literal column_literal
  schema_literal="$(sql_string_literal "$STAGING_DB_NAME")"
  table_literal="$(sql_string_literal "$table")"
  column_literal="$(sql_string_literal "$column")"
  [[ "$(mysql_staging -e "
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE table_schema = $schema_literal
      AND table_name = $table_literal
      AND column_name = $column_literal
      AND data_type IN ('tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint');
  ")" == "1" ]]
}

configured_chunk_spec() {
  local table="$1"
  local spec spec_table spec_column spec_mode
  local IFS=';'

  for spec in $CHUNK_COLUMN_OVERRIDES; do
    spec_table="${spec%%:*}"
    spec="${spec#*:}"
    spec_column="${spec%%:*}"
    spec_mode="${spec#*:}"
    if [[ "$spec_mode" == "$spec_column" ]]; then
      spec_mode="range"
    fi

    if [[ "$spec_table" == "$table" ]]; then
      if numeric_column_exists "$table" "$spec_column"; then
        printf '%s\t%s\n' "$spec_column" "$spec_mode"
      else
        log "Configured chunk column $table.$spec_column does not exist or is not numeric; falling back"
      fi
      return 0
    fi
  done
}

table_min_max_column() {
  local table="$1"
  local column="$2"
  local schema_id table_id column_id
  schema_id="$(sql_identifier "$STAGING_DB_NAME")"
  table_id="$(sql_identifier "$table")"
  column_id="$(sql_identifier "$column")"
  mysql_staging -e "SELECT COALESCE(MIN($column_id), 0), COALESCE(MAX($column_id), -1) FROM $schema_id.$table_id;"
}

dump_whole_table_once() {
  local table="$1"
  local safe_table final_file
  safe_table="$(safe_file_name "$table")"
  final_file="$DUMP_DIR/tables/${safe_table}.sql.gz"

  if validated_gzip_exists "$final_file"; then
    log "Table $table already exists and validates"
    return 0
  fi

  atomic_gzip_dump "$final_file" \
    mysqldump_staging \
      --single-transaction \
      --quick \
      --skip-triggers \
      --no-create-info \
      --complete-insert \
      --hex-blob \
      --default-character-set=utf8mb4 \
      --set-gtid-purged=OFF \
      --no-tablespaces \
      "$STAGING_DB_NAME" "$table"
}

dump_whole_table() {
  local table="$1"
  run_with_retries "Dump table $table" dump_whole_table_once "$table"
}

dump_chunk_once() {
  local table="$1"
  local column="$2"
  local start="$3"
  local end="$4"
  local final_file="$5"
  local column_id
  column_id="$(sql_identifier "$column")"

  if validated_gzip_exists "$final_file"; then
    return 0
  fi

  atomic_gzip_dump "$final_file" \
    mysqldump_staging \
      --single-transaction \
      --quick \
      --skip-triggers \
      --no-create-info \
      --complete-insert \
      --hex-blob \
      --default-character-set=utf8mb4 \
      --set-gtid-purged=OFF \
      --no-tablespaces \
      --where="$column_id BETWEEN $start AND $end" \
      "$STAGING_DB_NAME" "$table"
}

dump_chunk() {
  local table="$1"
  local column="$2"
  local start="$3"
  local end="$4"
  local final_file="$5"
  run_with_retries "Dump table $table chunk $column $start-$end" dump_chunk_once "$table" "$column" "$start" "$end" "$final_file"
}

dump_range_chunked_table() {
  local table="$1"
  local column="$2"
  local safe_table chunk_dir done_file min_max min_pk max_pk start end final_file

  safe_table="$(safe_file_name "$table")"
  chunk_dir="$DUMP_DIR/tables/${safe_table}"
  done_file="$DUMP_DIR/tables/${safe_table}.chunks.done"

  if [[ -f "$done_file" ]]; then
    log "Chunked table $table already marked complete"
    return 0
  fi

  mkdir -p "$chunk_dir"
  min_max="$(table_min_max_column "$table" "$column")"
  min_pk="$(printf '%s\n' "$min_max" | awk '{print $1}')"
  max_pk="$(printf '%s\n' "$min_max" | awk '{print $2}')"

  if [[ -z "$min_pk" || -z "$max_pk" || "$max_pk" -lt "$min_pk" ]]; then
    log "Table $table is empty; marking chunked table complete"
    : > "$done_file"
    return 0
  fi

  log "Chunking $table by $column from $min_pk to $max_pk in ranges of $CHUNK_RANGE_SIZE"
  start="$min_pk"
  while [[ "$start" -le "$max_pk" ]]; do
    end=$((start + CHUNK_RANGE_SIZE - 1))
    if [[ "$end" -gt "$max_pk" ]]; then
      end="$max_pk"
    fi

    final_file="$(printf '%s/%020d-%020d.sql.gz' "$chunk_dir" "$start" "$end")"
    dump_chunk "$table" "$column" "$start" "$end" "$final_file"
    start=$((end + 1))
  done

  : > "$done_file"
}

table_distinct_numeric_values() {
  local table="$1"
  local column="$2"
  local schema_id table_id column_id
  schema_id="$(sql_identifier "$STAGING_DB_NAME")"
  table_id="$(sql_identifier "$table")"
  column_id="$(sql_identifier "$column")"
  mysql_staging -e "SELECT DISTINCT $column_id FROM $schema_id.$table_id ORDER BY $column_id;"
}

dump_distinct_chunk_once() {
  local table="$1"
  local column="$2"
  local value="$3"
  local final_file="$4"
  local column_id
  column_id="$(sql_identifier "$column")"

  if validated_gzip_exists "$final_file"; then
    return 0
  fi

  atomic_gzip_dump "$final_file" \
    mysqldump_staging \
      --single-transaction \
      --quick \
      --skip-triggers \
      --no-create-info \
      --complete-insert \
      --hex-blob \
      --default-character-set=utf8mb4 \
      --set-gtid-purged=OFF \
      --no-tablespaces \
      --where="$column_id = $value" \
      "$STAGING_DB_NAME" "$table"
}

dump_distinct_chunk() {
  local table="$1"
  local column="$2"
  local value="$3"
  local final_file="$4"
  run_with_retries "Dump table $table chunk $column=$value" dump_distinct_chunk_once "$table" "$column" "$value" "$final_file"
}

dump_distinct_chunked_table() {
  local table="$1"
  local column="$2"
  local safe_table chunk_dir done_file values_file value final_file

  safe_table="$(safe_file_name "$table")"
  chunk_dir="$DUMP_DIR/tables/${safe_table}"
  done_file="$DUMP_DIR/tables/${safe_table}.chunks.done"
  values_file="$chunk_dir/${column}.values"

  if [[ -f "$done_file" ]]; then
    log "Chunked table $table already marked complete"
    return 0
  fi

  rm -f "$DUMP_DIR/tables/${safe_table}.sql.gz.tmp"
  mkdir -p "$chunk_dir"

  if [[ ! -s "$values_file" ]]; then
    table_distinct_numeric_values "$table" "$column" > "$values_file.tmp"
    mv "$values_file.tmp" "$values_file"
  fi

  log "Chunking $table by distinct $column values from $values_file"
  while IFS=$'\t' read -r value; do
    [[ -n "$value" ]] || continue
    final_file="$(printf '%s/%020d.sql.gz' "$chunk_dir" "$value")"
    dump_distinct_chunk "$table" "$column" "$value" "$final_file"
  done < "$values_file"

  : > "$done_file"
}

chunked_table_validates() {
  local table="$1"
  local safe_table chunk_dir done_file chunk_file
  safe_table="$(safe_file_name "$table")"
  chunk_dir="$DUMP_DIR/tables/${safe_table}"
  done_file="$DUMP_DIR/tables/${safe_table}.chunks.done"

  [[ -f "$done_file" ]] || return 1
  [[ -d "$chunk_dir" ]] || return 1

  while IFS= read -r chunk_file; do
    validated_gzip_exists "$chunk_file" || return 1
  done < <(find "$chunk_dir" -type f -name '*.sql.gz' | sort)
}

table_dump_complete() {
  local table="$1"
  local safe_table whole_file
  safe_table="$(safe_file_name "$table")"
  whole_file="$DUMP_DIR/tables/${safe_table}.sql.gz"

  validated_gzip_exists "$whole_file" || chunked_table_validates "$table"
}

dump_table_once() {
  local table="$1"
  local bytes chunk_spec chunk_column chunk_mode pk

  if table_dump_complete "$table"; then
    log "Table $table already complete"
    return 0
  fi

  bytes="$(table_data_bytes "$table")"
  chunk_spec="$(configured_chunk_spec "$table" || true)"
  if [[ -n "$chunk_spec" ]]; then
    chunk_column="$(printf '%s\n' "$chunk_spec" | awk '{print $1}')"
    chunk_mode="$(printf '%s\n' "$chunk_spec" | awk '{print $2}')"
  else
    chunk_column="$(single_numeric_primary_key "$table" || true)"
    chunk_mode="range"
  fi

  if [[ -n "$chunk_column" && "$bytes" -ge "$CHUNK_TABLE_MIN_BYTES" ]]; then
    case "$chunk_mode" in
      distinct)
        dump_distinct_chunked_table "$table" "$chunk_column"
        ;;
      range)
        dump_range_chunked_table "$table" "$chunk_column"
        ;;
      *)
        die "Unsupported chunk mode '$chunk_mode' for table $table"
        ;;
    esac
  else
    dump_whole_table "$table"
  fi
}

dump_table() {
  local table="$1"
  run_with_retries "Prepare/dump table $table" dump_table_once "$table"
}

dump_all_tables() {
  local table_file="$DUMP_DIR/tables.tsv"
  write_table_list

  while IFS=$'\t' read -r table; do
    [[ -n "$table" ]] || continue
    dump_table "$table"
  done < "$table_file"

  : > "$DUMP_DIR/dump.complete"
  log "Dump complete"
}

validate_complete_dump() {
  [[ -f "$DUMP_DIR/dump.complete" ]] || die "Dump is not marked complete: $DUMP_DIR/dump.complete missing"
  validated_gzip_exists "$DUMP_DIR/schema.sql.gz" || die "Schema dump is missing or invalid"

  local table_file="$DUMP_DIR/tables.tsv"
  [[ -f "$table_file" ]] || die "Missing table list: $table_file"

  while IFS=$'\t' read -r table; do
    [[ -n "$table" ]] || continue
    local safe_table whole_file chunks_done
    safe_table="$(safe_file_name "$table")"
    whole_file="$DUMP_DIR/tables/${safe_table}.sql.gz"
    chunks_done="$DUMP_DIR/tables/${safe_table}.chunks.done"

    if [[ -f "$chunks_done" ]]; then
      chunked_table_validates "$table" || die "Chunked table dump is marked complete but has invalid chunks: $table"
      continue
    fi

    validated_gzip_exists "$whole_file" || die "Table dump is missing or invalid: $whole_file"
  done < "$table_file"
}

restore_sql_gzip() {
  local file="$1"
  log "Importing $file"
  gunzip -c "$file" | docker compose exec -T "$LOCAL_DB_SERVICE" \
    mysql \
      --max_allowed_packet=1G \
      -u"$LOCAL_DB_ROOT_USER" \
      -p"$LOCAL_DB_ROOT_PASS" \
      "$LOCAL_DB_NAME"
}

docker_is_ready() {
  docker info >/dev/null 2>&1
}

ensure_docker_ready() {
  if docker_is_ready; then
    return 0
  fi

  if [[ "$AUTO_START_DOCKER" == "true" && "$(uname -s)" == "Darwin" ]]; then
    log "Docker daemon is not ready; opening Docker Desktop"
    open -a Docker >/dev/null 2>&1 || log "Could not open Docker Desktop automatically"
  else
    log "Docker daemon is not ready"
  fi

  local waited=0
  while [[ "$waited" -lt "$DOCKER_READY_TIMEOUT_SECONDS" ]]; do
    if docker_is_ready; then
      log "Docker daemon is ready"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done

  die "Docker daemon did not become ready after ${DOCKER_READY_TIMEOUT_SECONDS}s. Start Docker Desktop and re-run."
}

restore_local_db() {
  validate_complete_dump

  if [[ "$LOCAL_DB_NAME" != "OM6529" && "${ALLOW_NON_OM6529_LOCAL_DB:-false}" != "true" ]]; then
    die "Refusing to replace non-default local DB $LOCAL_DB_NAME without ALLOW_NON_OM6529_LOCAL_DB=true"
  fi

  if [[ "$CONFIRM_REPLACE_LOCAL_DB" != "$LOCAL_DB_NAME" ]]; then
    die "Refusing to drop local DB. Re-run with --yes or set CONFIRM_REPLACE_LOCAL_DB=$LOCAL_DB_NAME"
  fi

  ensure_docker_ready

  log "Replacing local Docker MySQL database $LOCAL_DB_NAME"
  docker compose exec -T "$LOCAL_DB_SERVICE" \
    mysql \
      -u"$LOCAL_DB_ROOT_USER" \
      -p"$LOCAL_DB_ROOT_PASS" \
      -e "DROP DATABASE IF EXISTS \`$LOCAL_DB_NAME\`; CREATE DATABASE \`$LOCAL_DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"

  restore_sql_gzip "$DUMP_DIR/schema.sql.gz"

  find "$DUMP_DIR/tables" -type f -name '*.sql.gz' | sort | while IFS= read -r dump_file; do
    restore_sql_gzip "$dump_file"
  done

  log "Local database restore complete"
}

main() {
  parse_args "$@"
  load_config
  prepare_fresh_dump_dir
  prepare_workspace
  trap cleanup EXIT

  case "$MODE" in
    dump)
      dump_schema
      dump_all_tables
      validate_complete_dump
      ;;
    restore)
      restore_local_db
      ;;
    sync)
      dump_schema
      dump_all_tables
      restore_local_db
      ;;
    *)
      die "Unsupported mode: $MODE"
      ;;
  esac
}

main "$@"
