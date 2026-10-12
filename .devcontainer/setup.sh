#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

kntr_workspace_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
kntr_backend_dir="${kntr_workspace_dir}/kntr-package/kntr-backend"
kntr_runtime_dir="${kntr_workspace_dir}/.runtime"

kntr_prepare_storage() {
  if [[ -L "${kntr_runtime_dir}" || -L "${kntr_runtime_dir}/uploads" ]]; then
    printf '%s\n' 'Runtime storage must be an ordinary private directory.' >&2
    return 1
  fi
  mkdir -p -- "${kntr_runtime_dir}/uploads"
  chmod 700 -- "${kntr_runtime_dir}" "${kntr_runtime_dir}/uploads"
}

kntr_add_forwarded_origin() {
  # Codespaces injects these variables when available. Native Capacitor origins
  # remain allowed even when a local dev-container has no forwarded hostname.
  if [[ -n "${CODESPACE_NAME:-}" && -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]]; then
    if [[ ! "${CODESPACE_NAME}" =~ ^[a-zA-Z0-9-]+$ ||
          ! "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}" =~ ^[a-zA-Z0-9.-]+$ ]]; then
      printf '%s\n' 'Codespaces forwarding hostname is invalid.' >&2
      return 1
    fi
    local kntr_forwarded_origin="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
    case ",${ALLOWED_ORIGINS:-}," in
      *,"${kntr_forwarded_origin}",*) ;;
      *) export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:+${ALLOWED_ORIGINS},}${kntr_forwarded_origin}" ;;
    esac
  fi
}

kntr_wait_for_database() {
  (
    cd -- "${kntr_backend_dir}"
    node <<'NODE'
const { Client } = require('pg');
const { buildDatabaseOptions } = require('./src/config/databaseOptions');
const { setTimeout: delay } = require('node:timers/promises');
(async () => {
  const options = { ...buildDatabaseOptions(), connectionTimeoutMillis: 1000 };
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const client = new Client(options);
    try {
      await client.connect();
      await client.query('SELECT 1');
      console.log('Private PostgreSQL connection is ready.');
      return;
    } catch (_) {
      // Do not expose database credentials or server details in setup logs.
    } finally { await client.end().catch(() => {}); }
    await delay(1000);
  }
  throw new Error('Private PostgreSQL did not become ready; check the database container and preserved credentials.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
NODE
  )
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  kntr_prepare_storage
  kntr_add_forwarded_origin
  cd -- "${kntr_backend_dir}"
  npm ci --omit=dev
  kntr_wait_for_database
  npm run db:prepare
  printf '%s\n' 'KNTR dependencies and database are ready. The start hook will launch the API.'
fi
