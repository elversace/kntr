#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/setup.sh"

kntr_prepare_storage
kntr_add_forwarded_origin
kntr_pid_file="${kntr_runtime_dir}/api.pid"
kntr_api_script="${kntr_backend_dir}/src/app.js"

kntr_probe_api() {
  node <<'NODE'
(async () => {
  let response;
  try {
    response = await fetch('http://127.0.0.1:3000/ready', { signal: AbortSignal.timeout(2000) });
  } catch (_) { process.exitCode = 1; return; }
  try {
    const body = await response.json();
    process.exitCode = response.ok && body.status === 'ok' && body.service === 'kntr API' ? 0 : 2;
  } catch (_) { process.exitCode = 2; }
})().catch(() => { process.exitCode = 2; });
NODE
}

if kntr_probe_api; then
  printf '%s\n' 'KNTR API is already ready on port 3000; no duplicate process was started.'
  exit 0
else
  kntr_probe_status=$?
  if [[ "${kntr_probe_status}" -eq 2 ]]; then
    printf '%s\n' 'Port 3000 already answers HTTP but KNTR is not ready. Inspect .runtime/api.log and stop the existing process before retrying.' >&2
    exit 1
  fi
fi

if [[ -f "${kntr_pid_file}" ]]; then
  IFS= read -r kntr_existing_pid < "${kntr_pid_file}" || true
  if [[ "${kntr_existing_pid:-}" =~ ^[1-9][0-9]*$ ]] && kill -0 "${kntr_existing_pid}" 2>/dev/null &&
     [[ -r "/proc/${kntr_existing_pid}/cmdline" ]] &&
     tr '\0' '\n' < "/proc/${kntr_existing_pid}/cmdline" | grep -Fxq -- "${kntr_api_script}"; then
    printf '%s\n' 'The recorded KNTR process is running but not ready; inspect .runtime/api.log before restarting.' >&2
    exit 1
  fi
  rm -f -- "${kntr_pid_file}"
fi

[[ -d "${kntr_backend_dir}/node_modules/pg" ]] || {
  printf '%s\n' 'Run bash .devcontainer/setup.sh before starting the API.' >&2
  exit 1
}
kntr_wait_for_database
cd -- "${kntr_backend_dir}"
npm run db:prepare
: > "${kntr_runtime_dir}/api.log"
chmod 600 -- "${kntr_runtime_dir}/api.log"
nohup node "${kntr_api_script}" > "${kntr_runtime_dir}/api.log" 2>&1 < /dev/null &
kntr_new_pid=$!
printf '%s\n' "${kntr_new_pid}" > "${kntr_pid_file}"
chmod 600 -- "${kntr_pid_file}"

for kntr_attempt in {1..30}; do
  if ! kill -0 "${kntr_new_pid}" 2>/dev/null; then
    rm -f -- "${kntr_pid_file}"
    printf '%s\n' 'KNTR API stopped during startup; inspect .runtime/api.log.' >&2
    exit 1
  fi
  if kntr_probe_api; then
    printf '%s\n' 'KNTR API is ready on port 3000. Forwarded port privacy was not changed.'
    if [[ -n "${CODESPACE_NAME:-}" && -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]]; then
      printf 'API address: https://%s-3000.%s/v1\n' "${CODESPACE_NAME}" "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
    fi
    exit 0
  fi
  sleep 1
done
printf '%s\n' 'KNTR API did not become ready; inspect .runtime/api.log. The recorded process was left available for diagnosis.' >&2
exit 1
