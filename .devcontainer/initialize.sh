#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

kntr_container_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
kntr_app_env="${kntr_container_dir}/app.env"
kntr_db_env="${kntr_container_dir}/db.env"
kntr_app_tmp=''
kntr_db_tmp=''
kntr_jwt_secret=''
kntr_refresh_secret=''
kntr_app_password=''
kntr_db_password=''

kntr_cleanup() {
  if [[ -n "${kntr_app_tmp}" ]]; then rm -f -- "${kntr_app_tmp}"; fi
  if [[ -n "${kntr_db_tmp}" ]]; then rm -f -- "${kntr_db_tmp}"; fi
}
trap kntr_cleanup EXIT

kntr_fail() {
  printf '%s\n' "Secret initialization stopped: $1" >&2
  exit 1
}

kntr_read_secrets() {
  local kntr_file="$1" kntr_kind="$2" kntr_key kntr_value kntr_count=0
  [[ -f "${kntr_file}" && ! -L "${kntr_file}" ]] || kntr_fail 'expected a regular private environment file'
  while IFS='=' read -r kntr_key kntr_value || [[ -n "${kntr_key:-}" ]]; do
    [[ "${kntr_value}" =~ ^[a-f0-9]{64}$ ]] || kntr_fail 'existing secrets are incomplete or malformed; no file was replaced'
    case "${kntr_kind}:${kntr_key}" in
      app:JWT_SECRET)
        [[ -z "${kntr_jwt_secret}" ]] || kntr_fail 'duplicate JWT secret'
        kntr_jwt_secret="${kntr_value}" ;;
      app:JWT_REFRESH_SECRET)
        [[ -z "${kntr_refresh_secret}" ]] || kntr_fail 'duplicate refresh secret'
        kntr_refresh_secret="${kntr_value}" ;;
      app:DB_PASSWORD)
        [[ -z "${kntr_app_password}" ]] || kntr_fail 'duplicate application database password'
        kntr_app_password="${kntr_value}" ;;
      db:POSTGRES_PASSWORD)
        [[ -z "${kntr_db_password}" ]] || kntr_fail 'duplicate database password'
        kntr_db_password="${kntr_value}" ;;
      *) kntr_fail 'unexpected key in a private environment file' ;;
    esac
    kntr_count=$((kntr_count + 1))
  done < "${kntr_file}"
  if [[ "${kntr_kind}" == app ]]; then
    [[ "${kntr_count}" -eq 3 ]] || kntr_fail 'application environment file is incomplete'
    [[ "${kntr_jwt_secret}" != "${kntr_refresh_secret}" ]] || kntr_fail 'JWT secrets must be independent'
  else
    [[ "${kntr_count}" -eq 1 ]] || kntr_fail 'database environment file is incomplete'
  fi
  chmod 600 -- "${kntr_file}"
}

command -v openssl >/dev/null 2>&1 || kntr_fail 'openssl is required on the container host'
if [[ -e "${kntr_app_env}" || -L "${kntr_app_env}" ]]; then kntr_read_secrets "${kntr_app_env}" app; fi
if [[ -e "${kntr_db_env}" || -L "${kntr_db_env}" ]]; then kntr_read_secrets "${kntr_db_env}" db; fi
if [[ -n "${kntr_app_password}" && -n "${kntr_db_password}" && "${kntr_app_password}" != "${kntr_db_password}" ]]; then
  kntr_fail 'database passwords do not match; existing files were preserved'
fi
kntr_database_password="${kntr_app_password:-${kntr_db_password}}"
if [[ -z "${kntr_database_password}" ]]; then kntr_database_password="$(openssl rand -hex 32)"; fi

if [[ ! -e "${kntr_app_env}" ]]; then
  kntr_jwt_secret="$(openssl rand -hex 32)"
  kntr_refresh_secret="$(openssl rand -hex 32)"
  while [[ "${kntr_jwt_secret}" == "${kntr_refresh_secret}" ]]; do kntr_refresh_secret="$(openssl rand -hex 32)"; done
  kntr_app_tmp="$(mktemp "${kntr_container_dir}/.app.env.XXXXXX")"
  printf 'JWT_SECRET=%s\nJWT_REFRESH_SECRET=%s\nDB_PASSWORD=%s\n' \
    "${kntr_jwt_secret}" "${kntr_refresh_secret}" "${kntr_database_password}" > "${kntr_app_tmp}"
  chmod 600 -- "${kntr_app_tmp}"
  mv -n -- "${kntr_app_tmp}" "${kntr_app_env}"
fi
if [[ ! -e "${kntr_db_env}" ]]; then
  kntr_db_tmp="$(mktemp "${kntr_container_dir}/.db.env.XXXXXX")"
  printf 'POSTGRES_PASSWORD=%s\n' "${kntr_database_password}" > "${kntr_db_tmp}"
  chmod 600 -- "${kntr_db_tmp}"
  mv -n -- "${kntr_db_tmp}" "${kntr_db_env}"
fi

# Re-read final files to detect conflicting simultaneous initialization without
# overwriting credentials or printing their values.
kntr_jwt_secret=''
kntr_refresh_secret=''
kntr_app_password=''
kntr_db_password=''
kntr_read_secrets "${kntr_app_env}" app
kntr_read_secrets "${kntr_db_env}" db
[[ "${kntr_app_password}" == "${kntr_db_password}" ]] || kntr_fail 'database passwords do not match'
printf '%s\n' 'Private test secrets are ready; existing credentials were preserved.'
