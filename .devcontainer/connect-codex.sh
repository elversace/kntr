#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

kntr_connection_mode="${1:---connect}"
case "${kntr_connection_mode}" in
  --help|-h)
    printf '%s\n' 'Usage: bash .devcontainer/connect-codex.sh [--connect|--check]' \
      'Run inside the owner Codespace. --check never installs, logs in, or starts a service.'
    exit 0 ;;
  --connect|--check) ;;
  *) printf '%s\n' 'Expected --connect, --check, or --help.' >&2; exit 2 ;;
esac

if [[ "${CODESPACES:-}" != true || ! "${CODESPACE_NAME:-}" =~ ^[a-zA-Z0-9-]+$ ]]; then
  printf '%s\n' 'Run this connection setup in the Codespaces Terminal, not in a different preparation environment.' >&2
  exit 1
fi

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/setup.sh"
kntr_require_runtime
cd -- "${kntr_workspace_dir}"

if ! command -v codex >/dev/null 2>&1; then
  if [[ "${kntr_connection_mode}" == --check ]]; then
    printf '%s\n' 'Codex CLI is not installed in this Codespace.' >&2
    exit 1
  fi
  npm install --global @openai/codex@0.162.1
  hash -r
fi

codex --version
if ! codex remote-control --help >/dev/null 2>&1; then
  printf '%s\n' 'This Codex CLI does not support Remote Control. Update it using the official Codex installation instructions.' >&2
  exit 1
fi
if [[ "${kntr_connection_mode}" == --check ]]; then
  printf '%s\n' 'Codespaces runtime and Codex Remote command are available. Pairing, account eligibility, and remote execution were not tested.'
  exit 0
fi

if ! codex login status >/dev/null 2>&1; then
  codex login --device-auth
fi

printf '%s\n' 'Starting official Codex Remote with the requested approval defaults for this host.'
codex remote-control start \
  -c 'approval_policy="never"' \
  -c 'sandbox_mode="danger-full-access"'
printf '%s\n' 'Use the short-lived pairing code only in the official ChatGPT Remote connection screen for your account.'
codex remote-control pair
