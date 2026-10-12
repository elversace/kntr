#!/usr/bin/env bash
set -Eeuo pipefail
kntr_workspace_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
kntr_pid_file="${kntr_workspace_dir}/.runtime/api.pid"
kntr_api_script="${kntr_workspace_dir}/kntr-package/kntr-backend/src/app.js"

if [[ ! -f "${kntr_pid_file}" ]]; then
  printf '%s\n' 'No KNTR process is recorded. Stop the Codespace itself to stop compute usage.'
  exit 0
fi
IFS= read -r kntr_pid < "${kntr_pid_file}" || true
if [[ ! "${kntr_pid:-}" =~ ^[1-9][0-9]*$ ]] || ! kill -0 "${kntr_pid}" 2>/dev/null; then
  rm -f -- "${kntr_pid_file}"
  printf '%s\n' 'No running KNTR process was found; the stale marker was removed.'
  exit 0
fi
if [[ ! -r "/proc/${kntr_pid}/cmdline" ]] ||
   ! tr '\0' '\n' < "/proc/${kntr_pid}/cmdline" | grep -Fxq -- "${kntr_api_script}"; then
  printf '%s\n' 'The recorded PID does not belong to this KNTR API; no process was stopped.' >&2
  exit 1
fi
kill -TERM "${kntr_pid}"
for kntr_attempt in {1..12}; do
  if ! kill -0 "${kntr_pid}" 2>/dev/null; then
    rm -f -- "${kntr_pid_file}"
    printf '%s\n' 'KNTR API stopped. Use GitHub Stop codespace to stop compute usage.'
    exit 0
  fi
  sleep 1
done
printf '%s\n' 'KNTR shutdown is still pending; no unrelated process was killed. Inspect the API log or stop the Codespace.' >&2
exit 1
