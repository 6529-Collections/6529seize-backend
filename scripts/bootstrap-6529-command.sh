#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_BIN="$REPO_ROOT/bin"
PRINT_EXPORT_ONLY="0"

if [[ "${1:-}" == "--print-export" ]]; then
  PRINT_EXPORT_ONLY="1"
  shift
fi

if [[ "$#" -gt 0 ]]; then
  echo "Usage: ./bin/6529 bootstrap [--print-export]" >&2
  exit 1
fi

clean_path=""
IFS=':' read -r -a path_parts <<< "${PATH:-}"
for part in "${path_parts[@]}"; do
  if [[ -z "$part" || "$part" == "$REPO_BIN" ]]; then
    continue
  fi
  clean_path="${clean_path:+${clean_path}:}${part}"
done

REAL_COREPACK="$(PATH="$clean_path" command -v corepack 2>/dev/null || true)"
if [[ -z "$REAL_COREPACK" ]]; then
  echo "Corepack is required. Install a supported Node.js release that includes Corepack." >&2
  exit 1
fi

EXPECTED_NPM="$(
  node -p "String(require('$REPO_ROOT/package.json').packageManager).split('npm@')[1]"
)"
RESOLVED_NPM="$(
  cd "$REPO_ROOT"
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$REAL_COREPACK" npm --version
)"

if [[ "$RESOLVED_NPM" != "$EXPECTED_NPM" ]]; then
  echo "Corepack resolved npm $RESOLVED_NPM, expected $EXPECTED_NPM." >&2
  exit 1
fi

emit_repo_shell_hook() {
  local sync_function="$1"

  cat <<EOF
${sync_function}() {
  local _6529_clean_path="" _6529_part="" _6529_old_ifs=""
  _6529_old_ifs="\$IFS"
  IFS=:
  set -- \$PATH
  IFS="\$_6529_old_ifs"

  for _6529_part in "\$@"; do
    if [ -z "\$_6529_part" ] || [ "\$_6529_part" = "$REPO_BIN" ]; then
      continue
    fi

    if [ -z "\$_6529_clean_path" ]; then
      _6529_clean_path="\$_6529_part"
    else
      _6529_clean_path="\${_6529_clean_path}:\$_6529_part"
    fi
  done

  case "\${PWD}/" in
    "$REPO_ROOT/"*)
      export PATH="$REPO_BIN\${_6529_clean_path:+:\$_6529_clean_path}"
      ;;
    *)
      export PATH="\$_6529_clean_path"
      ;;
  esac

  hash -r 2>/dev/null || true
}

${sync_function}

if [ -n "\${ZSH_VERSION:-}" ]; then
  autoload -U add-zsh-hook 2>/dev/null || true
  if typeset -f add-zsh-hook >/dev/null 2>&1; then
    add-zsh-hook -D chpwd ${sync_function} 2>/dev/null || true
    add-zsh-hook -D precmd ${sync_function} 2>/dev/null || true
    add-zsh-hook chpwd ${sync_function}
    add-zsh-hook precmd ${sync_function}
  fi
elif [ -n "\${BASH_VERSION:-}" ]; then
  case ";\${PROMPT_COMMAND:-};" in
    *";${sync_function};"*) ;;
    *)
      if [ -n "\${PROMPT_COMMAND:-}" ]; then
        PROMPT_COMMAND="${sync_function};\${PROMPT_COMMAND}"
      else
        PROMPT_COMMAND="${sync_function}"
      fi
      ;;
  esac
fi
EOF
}

repo_tag="$(printf '%s' "$REPO_ROOT" | cksum | awk '{print $1}')"
marker_begin="# >>> 6529 backend command scope ${repo_tag} >>>"
marker_end="# <<< 6529 backend command scope ${repo_tag} <<<"
sync_function="_6529_backend_sync_path_${repo_tag}"

if [[ "$PRINT_EXPORT_ONLY" == "1" ]]; then
  emit_repo_shell_hook "$sync_function"
  exit 0
fi

shell_name="${SHELL##*/}"
case "$shell_name" in
  zsh)
    rc_file="${HOME}/.zshrc"
    ;;
  bash|*)
    rc_file="${HOME}/.bashrc"
    ;;
esac

mkdir -p "$(dirname "$rc_file")"
touch "$rc_file"

temporary_file="$(mktemp)"
trap 'rm -f "$temporary_file"' EXIT

awk \
  -v begin="$marker_begin" \
  -v end="$marker_end" '
  $0 == begin { skipping = 1; next }
  $0 == end { skipping = 0; next }
  !skipping { print }
' "$rc_file" > "$temporary_file"

block="$(emit_repo_shell_hook "$sync_function")"
printf '\n%s\n%s\n%s\n' "$marker_begin" "$block" "$marker_end" >> "$temporary_file"
mv "$temporary_file" "$rc_file"

cat <<EOF
Pinned npm is available through Corepack:
  $RESOLVED_NPM

Updated:
  $rc_file

The \`6529\` command is now scoped to:
  $REPO_ROOT

Outside that directory tree, \`6529\` and the package-manager guards are not on PATH.

Open a new shell, source the file above, or activate the current shell with:
  source <("$REPO_ROOT/bin/6529" bootstrap --print-export)

Then install the current package with:
  6529 ci
EOF
