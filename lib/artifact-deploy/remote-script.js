function escapeShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

export function buildRemoteDeployScript(payload = {}) {
  const remote = payload.remote || {}
  const artifact = payload.artifact || {}
  const startup = payload.startup || {}
  const deploy = payload.deploy || {}
  const verify = payload.verify || {}
  const healthCheck = verify.healthCheck || null
  const baseDir = String(remote.baseDir || '.')
  const versionName = String(payload.versionName || 'unknown')
  const releaseDir = `${baseDir}/releases/${versionName}`
  const currentLink = `${baseDir}/current`
  const serviceName = String(startup.serviceName || '')
  const startupMode = String(startup.mode || 'command')
  const startupCommand = String(
    startup.command || (startupMode === 'systemd' ? `sudo systemctl restart ${serviceName}` : ''),
  )
  const rollbackCommand = String(startup.rollbackCommand || startupCommand)
  const verifyCommand = String(
    verify.command || (startupMode === 'systemd' ? `sudo systemctl is-active --quiet ${serviceName}` : ''),
  )
  const installCommand = String(deploy.installCommand || '')
  const healthCheckUrl = String(healthCheck?.url || '')
  const healthCheckTimeoutSeconds = Number(healthCheck?.timeoutSeconds || 10)
  const healthCheckMaxWaitSeconds = Number(verify.maxWaitSeconds || healthCheck?.maxWaitSeconds || 24)
  const retryIntervalSeconds = Number(
    verify.retryIntervalSeconds || healthCheck?.retryIntervalSeconds || 2,
  )

  return `#!/usr/bin/env bash
set -euo pipefail

APP_ROOT=${escapeShell(baseDir)}
ARCHIVE=${escapeShell(payload.uploadedBundlePath || '')}
RELEASE_DIR=${escapeShell(releaseDir)}
CURRENT_LINK=${escapeShell(currentLink)}
ENV_NAME=${escapeShell(payload.environment || 'production')}
VERSION_NAME=${escapeShell(versionName)}
INNER_ARCHIVE_NAME=${escapeShell(artifact.innerArchiveName || `${versionName}.tgz`)}
CHECKSUM_NAME=${escapeShell(artifact.checksumName || `${versionName}.tgz.sha256`)}
START_MODE=${escapeShell(startupMode)}
SERVICE_NAME=${escapeShell(serviceName)}
INSTALL_COMMAND=${escapeShell(installCommand)}
START_COMMAND=${escapeShell(startupCommand)}
ROLLBACK_COMMAND=${escapeShell(rollbackCommand)}
VERIFY_COMMAND=${escapeShell(verifyCommand)}
HEALTHCHECK_URL=${escapeShell(healthCheckUrl)}
HEALTHCHECK_TIMEOUT_SECONDS=${healthCheckTimeoutSeconds}
VERIFY_MAX_WAIT_SECONDS=${healthCheckMaxWaitSeconds}
VERIFY_RETRY_DELAY_SECONDS=${retryIntervalSeconds}
KEEP_RELEASES=${Number(deploy.keepReleases || 5)}

LOCK_FILE="$APP_ROOT/.deploy.lock"
LOCK_DIR="$APP_ROOT/.deploy.lock.d"
SHARED_DIR="$APP_ROOT/shared"
RELEASES_DIR="$APP_ROOT/releases"
UPLOADS_DIR="$APP_ROOT/uploads"
PREVIOUS_CURRENT_TARGET=""
BUNDLE_TEMP_DIR=""
CURRENT_PHASE="init"
RESULT_EMITTED=0
ROLLBACK_ATTEMPTED=false
ROLLBACK_SUCCEEDED=null
CURRENT_SWITCHED=0

json_escape() {
  local value="\${1-}"
  value="\${value//\\\\/\\\\\\\\}"
  value="\${value//\"/\\\\\"}"
  value="\${value//$'\\n'/\\\\n}"
  value="\${value//$'\\r'/\\\\r}"
  value="\${value//$'\\t'/\\\\t}"
  printf '%s' "$value"
}

build_summary_json() {
  local current_release="$1"
  printf '{"releaseName":"%s","currentRelease":"%s","serviceName":"%s","startupMode":"%s","healthUrl":"%s"}' \\
    "$(json_escape "$VERSION_NAME")" \\
    "$(json_escape "$current_release")" \\
    "$(json_escape "$SERVICE_NAME")" \\
    "$(json_escape "$START_MODE")" \\
    "$(json_escape "$HEALTHCHECK_URL")"
}

emit_result() {
  local ok="$1"
  local phase="$2"
  local message="$3"
  local summary_json="\${4:-null}"
  if [[ "$RESULT_EMITTED" -eq 1 ]]; then return; fi
  RESULT_EMITTED=1
  message="\${message//\\\\/\\\\\\\\}"
  message="\${message//\"/\\\\\"}"
  message="\${message//$'\\n'/\\\\n}"
  printf 'DX_REMOTE_RESULT={"ok":%s,"phase":"%s","message":"%s","rollbackAttempted":%s,"rollbackSucceeded":%s,"summary":%s}\\n' \\
    "$ok" "$phase" "$message" "$ROLLBACK_ATTEMPTED" "$ROLLBACK_SUCCEEDED" "$summary_json"
}

cleanup() {
  rm -rf "$BUNDLE_TEMP_DIR" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

run_command_at() {
  local cwd="$1"
  local command="$2"
  if [[ -z "$command" ]]; then return 0; fi
  (
    cd "$cwd"
    DX_RELEASE_DIR="$cwd" \\
    DX_CURRENT_LINK="$CURRENT_LINK" \\
    DX_PREVIOUS_RELEASE="$PREVIOUS_CURRENT_TARGET" \\
    DX_ENVIRONMENT="$ENV_NAME" \\
    DX_SERVICE_NAME="$SERVICE_NAME" \\
      bash -lc "$command"
  )
}

attempt_rollback() {
  if [[ -z "$PREVIOUS_CURRENT_TARGET" || ! -d "$PREVIOUS_CURRENT_TARGET" ]]; then
    return
  fi
  ROLLBACK_ATTEMPTED=true
  if ln -sfn "$PREVIOUS_CURRENT_TARGET" "$CURRENT_LINK" && run_command_at "$CURRENT_LINK" "$ROLLBACK_COMMAND"; then
    ROLLBACK_SUCCEEDED=true
  else
    ROLLBACK_SUCCEEDED=false
  fi
}

fail_after_switch() {
  local phase="$1"
  local message="$2"
  attempt_rollback
  emit_result false "$phase" "$message"
  exit 1
}

on_error() {
  local code=$?
  if [[ "$CURRENT_SWITCHED" -eq 1 && "$ROLLBACK_ATTEMPTED" == "false" ]]; then
    attempt_rollback
  fi
  emit_result false "$CURRENT_PHASE" "phase failed (exit $code)"
  exit "$code"
}

trap cleanup EXIT
trap on_error ERR

validate_path_within_base() {
  local base="$1"
  local target="$2"
  case "$target" in
    "$base"/*|"$base") ;;
    *) echo "目标路径越界: $target" >&2; exit 1 ;;
  esac
}

validate_archive_entries() {
  local archive="$1"
  local entry
  local tar_line
  local link_target
  while IFS= read -r entry; do
    if [[ "$entry" == /* || "$entry" =~ (^|/)\\.\\.(/|$) || "$entry" =~ \\.\\.\\\\ ]]; then
      echo "包含可疑路径条目: $entry" >&2
      exit 1
    fi
  done < <(tar -tzf "$archive")
  while IFS= read -r tar_line; do
    if [[ "$tar_line" == *" -> "* ]]; then
      link_target="\${tar_line##* -> }"
      if [[ "$link_target" == /* || "$link_target" =~ (^|/)\\.\\.(/|$) || "$link_target" =~ \\.\\.\\\\ ]]; then
        echo "包含可疑链接目标: $link_target" >&2
        exit 1
      fi
    fi
  done < <(tar -tvzf "$archive")
}

sha256_check() {
  local checksum_file="$1"
  local expected actual file
  expected="$(awk '{print $1}' "$checksum_file")"
  file="$(basename "$(awk '{print $2}' "$checksum_file")")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  else
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  fi
  [[ "$expected" == "$actual" ]]
}

retry_command() {
  local command="$1"
  local label="$2"
  local started_at elapsed
  if [[ -z "$command" ]]; then return 0; fi
  started_at="$(date +%s)"
  until run_command_at "$CURRENT_LINK" "$command"; do
    elapsed=$(( $(date +%s) - started_at ))
    if [[ "$elapsed" -ge "$VERIFY_MAX_WAIT_SECONDS" ]]; then
      echo "$label failed within $VERIFY_MAX_WAIT_SECONDS seconds" >&2
      return 1
    fi
    sleep "$VERIFY_RETRY_DELAY_SECONDS"
  done
}

CURRENT_PHASE="lock"
echo "DX_REMOTE_PHASE=lock"
mkdir -p "$RELEASES_DIR" "$SHARED_DIR" "$UPLOADS_DIR"
validate_path_within_base "$APP_ROOT" "$ARCHIVE"
validate_path_within_base "$APP_ROOT" "$RELEASE_DIR"
PREVIOUS_CURRENT_TARGET="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  flock -n 9
else
  mkdir "$LOCK_DIR"
fi

CURRENT_PHASE="extract"
echo "DX_REMOTE_PHASE=extract"
validate_archive_entries "$ARCHIVE"
BUNDLE_TEMP_DIR="$(mktemp -d "$APP_ROOT/.bundle-extract.XXXXXX")"
tar -xzf "$ARCHIVE" -C "$BUNDLE_TEMP_DIR"
INNER_ARCHIVE="$BUNDLE_TEMP_DIR/$INNER_ARCHIVE_NAME"
CHECKSUM_FILE="$BUNDLE_TEMP_DIR/$CHECKSUM_NAME"
if [[ ! -f "$INNER_ARCHIVE" || ! -f "$CHECKSUM_FILE" ]]; then
  echo "制品包缺少 $INNER_ARCHIVE_NAME 或 $CHECKSUM_NAME" >&2
  exit 1
fi
(cd "$BUNDLE_TEMP_DIR" && sha256_check "$CHECKSUM_NAME")
validate_archive_entries "$INNER_ARCHIVE"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"
tar -xzf "$INNER_ARCHIVE" -C "$RELEASE_DIR" --strip-components=1

CURRENT_PHASE="install"
echo "DX_REMOTE_PHASE=install"
run_command_at "$RELEASE_DIR" "$INSTALL_COMMAND"

CURRENT_PHASE="switch-current"
echo "DX_REMOTE_PHASE=switch-current"
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
CURRENT_SWITCHED=1

CURRENT_PHASE="startup"
echo "DX_REMOTE_PHASE=startup"
if ! run_command_at "$CURRENT_LINK" "$START_COMMAND"; then
  attempt_rollback
  emit_result false "startup" "startup command failed"
  exit 1
fi

CURRENT_PHASE="verify"
echo "DX_REMOTE_PHASE=verify"
current_release="$(readlink -f "$CURRENT_LINK")"
expected_release="$(readlink -f "$RELEASE_DIR")"
if [[ -z "$current_release" || "$current_release" != "$expected_release" ]]; then
  echo "current 软链接未指向本次 release: expected=$expected_release actual=\${current_release:-<empty>}" >&2
  fail_after_switch "verify" "current symlink verification failed"
fi

retry_command "$VERIFY_COMMAND" "verify command"
if [[ -n "$HEALTHCHECK_URL" ]]; then
  command -v curl >/dev/null 2>&1
  healthcheck_started_at="$(date +%s)"
  until curl -fsS --max-time "$HEALTHCHECK_TIMEOUT_SECONDS" "$HEALTHCHECK_URL" >/dev/null; do
    healthcheck_elapsed_seconds=$(( $(date +%s) - healthcheck_started_at ))
    if [[ "$healthcheck_elapsed_seconds" -ge "$VERIFY_MAX_WAIT_SECONDS" ]]; then
      echo "health check failed within $VERIFY_MAX_WAIT_SECONDS seconds: $HEALTHCHECK_URL" >&2
      fail_after_switch "verify" "health check failed"
    fi
    sleep "$VERIFY_RETRY_DELAY_SECONDS"
  done
fi

CURRENT_PHASE="cleanup"
echo "DX_REMOTE_PHASE=cleanup"
release_count=0
shopt -s nullglob
release_dirs=("$RELEASES_DIR"/*)
shopt -u nullglob
while IFS= read -r old_release; do
  release_count=$((release_count + 1))
  if [[ "$release_count" -gt "$KEEP_RELEASES" ]]; then rm -rf "$old_release"; fi
done < <(
  if [[ "\${#release_dirs[@]}" -gt 0 ]]; then ls -1dt "\${release_dirs[@]}"; fi
)

summary_json="$(build_summary_json "$current_release")"
emit_result true "cleanup" "ok" "$summary_json"
`
}
