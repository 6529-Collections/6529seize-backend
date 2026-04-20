#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_BIN_DIR="${HOME}/.local/bin"
GLOBAL_6529="${LOCAL_BIN_DIR}/6529"
REAL_NPM=""
NPM_GLOBAL_BIN=""
SFW_BIN_PATH=""

LEGACY_MARKER_BEGIN="# >>> 6529 repo bin >>>"
LEGACY_MARKER_END="# <<< 6529 repo bin <<<"
MANAGED_MARKER_BEGIN="# >>> 6529 command shim >>>"
MANAGED_MARKER_END="# <<< 6529 command shim <<<"

print_export_only="0"
if [[ "${1:-}" == "--print-export" ]]; then
  print_export_only="1"
fi

log() {
  echo "$*" >&2
  return
}

resolve_real_binary() {
  local name="$1" varname="$2"
  local repo_bin="$REPO_ROOT/bin"
  local clean_path="" part

  IFS=':' read -r -a _rrb_parts <<< "${PATH:-}"
  for part in "${_rrb_parts[@]}"; do
    if [[ -z "$part" || "$part" == "$repo_bin" ]]; then
      continue
    fi
    clean_path="${clean_path:+${clean_path}:}${part}"
  done

  local resolved=""
  resolved="$(PATH="$clean_path" command -v "$name" 2>/dev/null || true)"
  if [[ -z "$resolved" ]]; then
    log "Cannot find real '$name' outside the repo's bin/ shims."
    exit 1
  fi

  printf -v "$varname" '%s' "$resolved"
  return
}

resolve_npm_global_bin() {
  if [[ -z "$REAL_NPM" ]]; then
    return 0
  fi

  local npm_global_prefix=""
  npm_global_prefix="$("$REAL_NPM" prefix -g 2>/dev/null || true)"
  if [[ -n "$npm_global_prefix" ]]; then
    NPM_GLOBAL_BIN="${npm_global_prefix}/bin"
  fi

  if [[ -n "$NPM_GLOBAL_BIN" && ! -d "$NPM_GLOBAL_BIN" ]]; then
    NPM_GLOBAL_BIN=""
  fi
}

prepend_npm_global_bin_to_path() {
  if [[ -z "$NPM_GLOBAL_BIN" ]]; then
    return 0
  fi

  case ":$PATH:" in
    *":$NPM_GLOBAL_BIN:"*) ;;
    *) export PATH="$NPM_GLOBAL_BIN:$PATH" ;;
  esac
}

ensure_socket_firewall() {
  resolve_real_binary npm REAL_NPM
  resolve_npm_global_bin
  prepend_npm_global_bin_to_path

  if command -v sfw >/dev/null 2>&1 && sfw --help >/dev/null 2>&1; then
    SFW_BIN_PATH="$(command -v sfw)"
    return 0
  fi

  log "Installing Socket Firewall globally with the real npm binary..."
  if [[ "$(uname -s)" == "Darwin" ]]; then
    "$REAL_NPM" install --global sfw
  else
    local npm_global_prefix=""
    npm_global_prefix="$("$REAL_NPM" prefix -g 2>/dev/null || true)"
    if [[ -n "$npm_global_prefix" && -w "$npm_global_prefix" ]]; then
      "$REAL_NPM" install --global sfw
    else
      sudo "$REAL_NPM" install --global sfw
    fi
  fi

  resolve_npm_global_bin
  prepend_npm_global_bin_to_path

  if ! command -v sfw >/dev/null 2>&1 || ! sfw --help >/dev/null 2>&1; then
    log "Socket Firewall installation completed but 'sfw' is still not usable."
    exit 1
  fi

  SFW_BIN_PATH="$(command -v sfw)"
}

ensure_pinned_pnpm() {
  log "Activating the repo-pinned pnpm version with Corepack..."
  bash "$REPO_ROOT/scripts/setup-corepack-pnpm.sh" >&2
  return
}

detect_rc_file() {
  local shell_name="${SHELL##*/}"

  case "$shell_name" in
    zsh)
      printf '%s\n' "${HOME}/.zshrc"
      ;;
    bash|*)
      printf '%s\n' "${HOME}/.bashrc"
      ;;
  esac
  return
}

remove_managed_global_shim() {
  if [[ ! -e "$GLOBAL_6529" && ! -L "$GLOBAL_6529" ]]; then
    return 1
  fi

  if [[ -L "$GLOBAL_6529" ]]; then
    local target=""
    target="$(readlink "$GLOBAL_6529" 2>/dev/null || true)"
    if [[ "$target" == *"/bin/6529"* ]]; then
      rm -f "$GLOBAL_6529"
      return 0
    fi

    return 1
  fi

  if [[ -f "$GLOBAL_6529" ]] && grep -F -- "$REPO_ROOT/bin/6529" "$GLOBAL_6529" >/dev/null 2>&1; then
    rm -f "$GLOBAL_6529"
    return 0
  fi

  return 1
}

strip_managed_blocks() {
  local source_file="$1" output_file="$2"

  awk \
    -v legacy_begin="$LEGACY_MARKER_BEGIN" \
    -v legacy_end="$LEGACY_MARKER_END" \
    -v managed_begin="$MANAGED_MARKER_BEGIN" \
    -v managed_end="$MANAGED_MARKER_END" '
    $0 == legacy_begin { skipping = 1; next }
    $0 == legacy_end { skipping = 0; next }
    $0 == managed_begin { skipping = 1; next }
    $0 == managed_end { skipping = 0; next }
    !skipping { print }
  ' "$source_file" > "$output_file"
  return
}

render_shell_hook_body() {
  cat <<EOF
__6529_repo_root="$REPO_ROOT"
__6529_repo_bin="\$__6529_repo_root/bin"
EOF

  if [[ -n "$SFW_BIN_PATH" ]]; then
    cat <<EOF
export SFW_BIN="$SFW_BIN_PATH"
EOF
  fi

  cat <<'EOF'
__6529_sync_repo_bin_path() {
  local clean_path=""
  local remaining="${PATH:-}"
  local part=""

  while [ -n "$remaining" ]; do
    case "$remaining" in
      *:*)
        part="${remaining%%:*}"
        remaining="${remaining#*:}"
        ;;
      *)
        part="$remaining"
        remaining=""
        ;;
    esac

    if [ -z "$part" ] || [ "$part" = "$__6529_repo_bin" ]; then
      continue
    fi

    if [ -z "$clean_path" ]; then
      clean_path="$part"
    else
      clean_path="${clean_path}:$part"
    fi
  done

  case "$PWD/" in
    "$__6529_repo_root/"|"$__6529_repo_root"/*)
      PATH="$__6529_repo_bin${clean_path:+:$clean_path}"
      ;;
    *)
      PATH="$clean_path"
      ;;
  esac

  export PATH
  hash -r 2>/dev/null || true
}

if [ -n "${ZSH_VERSION:-}" ]; then
  autoload -Uz add-zsh-hook 2>/dev/null || true
  if command -v add-zsh-hook >/dev/null 2>&1; then
    add-zsh-hook -d chpwd __6529_sync_repo_bin_path 2>/dev/null || true
    add-zsh-hook -d precmd __6529_sync_repo_bin_path 2>/dev/null || true
    add-zsh-hook chpwd __6529_sync_repo_bin_path
    add-zsh-hook precmd __6529_sync_repo_bin_path
  fi
fi

if [ -n "${BASH_VERSION:-}" ]; then
  case ";${PROMPT_COMMAND:-};" in
    *";__6529_sync_repo_bin_path;"*) ;;
    *)
      if [ -n "${PROMPT_COMMAND:-}" ]; then
        PROMPT_COMMAND="__6529_sync_repo_bin_path;${PROMPT_COMMAND}"
      else
        PROMPT_COMMAND="__6529_sync_repo_bin_path"
      fi
      ;;
  esac
fi

__6529_sync_repo_bin_path
EOF
  return
}

append_managed_block() {
  local rc_file="$1"
  local tmp_file=""

  mkdir -p "$(dirname "$rc_file")"
  touch "$rc_file"

  tmp_file="$(mktemp)"
  strip_managed_blocks "$rc_file" "$tmp_file"

  {
    printf '\n%s\n' "$MANAGED_MARKER_BEGIN"
    render_shell_hook_body
    printf '%s\n' "$MANAGED_MARKER_END"
  } >> "$tmp_file"

  mv "$tmp_file" "$rc_file"
  return
}

if [[ "$print_export_only" == "1" ]]; then
  render_shell_hook_body
  exit 0
fi

ensure_socket_firewall
ensure_pinned_pnpm
PNPM_VERSION="$(pnpm --version 2>/dev/null || echo 'pnpm-not-found')"

removed_global_shim="0"
if remove_managed_global_shim; then
  removed_global_shim="1"
fi

rc_file="$(detect_rc_file)"
append_managed_block "$rc_file"

cat <<EOF
Socket Firewall is installed and available at:
  $SFW_BIN_PATH

Pinned pnpm is active:
  $PNPM_VERSION

Updated:
  $rc_file

The 6529 shim remains repo-local at:
  $REPO_ROOT/bin/6529

Open a new shell, or run:
  source "$rc_file"

If you want a one-liner for the current shell:
  source <("$REPO_ROOT/bin/6529" bootstrap --print-export)

Then install project dependencies:
  ./bin/6529 install

After that, these commands should resolve inside this repo:
  6529 run build
  6529 run backend:local
  6529 run api:local
EOF

if [[ "$removed_global_shim" == "1" ]]; then
  cat <<EOF

Removed the old managed global shim:
  $GLOBAL_6529
EOF
fi
