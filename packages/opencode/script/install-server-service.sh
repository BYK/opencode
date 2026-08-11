#!/usr/bin/env bash

set -Eeuo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run this script with sudo:" >&2
  echo "  sudo $0 ${1:-}" >&2
  exit 1
fi

target_user="${OPENCODE_USER:-${SUDO_USER:-}}"
if [[ -z "$target_user" || "$target_user" == "root" ]]; then
  echo "Could not determine the target user. Set OPENCODE_USER and run again." >&2
  exit 1
fi

target_home="$(getent passwd "$target_user" | cut -d: -f6)"
target_group="$(id -gn "$target_user")"
package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="${1:-$package_dir/dist/server}"
source_binary="$source_dir/opencode-server"
smoke_script="$package_dir/script/smoke-server.mjs"
service="${OPENCODE_SERVICE:-opencode.service}"
port="${OPENCODE_PORT:-4096}"
install_dir="$target_home/.opencode/server"
previous_dir="$target_home/.opencode/server.previous"
backup_dir="$target_home/.opencode/server.backups"
dropin_dir="/etc/systemd/system/$service.d"
dropin="$dropin_dir/10-fossilize-server.conf"
had_dropin=false
created_backup=false
archived_previous=""

if [[ ! -x "$source_binary" ]]; then
  echo "Missing server artifact: $source_binary" >&2
  echo "Build it first with: COREPACK_ENABLE_STRICT=0 pnpm --filter opencode build:server" >&2
  exit 1
fi

node_binary="${OPENCODE_NODE:-}"
if [[ -z "$node_binary" ]]; then
  for candidate in "$target_home/.volta/bin/node" /usr/local/bin/node /usr/bin/node; do
    if [[ -x "$candidate" ]]; then
      node_binary="$candidate"
      break
    fi
  done
fi
if [[ -z "$node_binary" ]]; then
  echo "Could not find Node. Set OPENCODE_NODE to its absolute path and run again." >&2
  exit 1
fi

echo "Running server artifact preflight checks..."
runuser -u "$target_user" -- env \
  HOME="$target_home" \
  VOLTA_HOME="$target_home/.volta" \
  PATH="$target_home/.volta/bin:/usr/local/bin:/usr/bin:/bin" \
  OPENCODE_SMOKE_PORT="${OPENCODE_SMOKE_PORT:-14096}" \
  "$node_binary" "$smoke_script" "$source_binary"

dropin_backup="$(mktemp)"
if [[ -f "$dropin" ]]; then
  cp "$dropin" "$dropin_backup"
  had_dropin=true
fi

rollback() {
  echo "Installation failed; restoring the previous service configuration." >&2
  if $had_dropin; then
    cp "$dropin_backup" "$dropin"
  else
    rm -f "$dropin"
  fi
  rm -rf "$install_dir"
  if $created_backup && [[ -d "$previous_dir" ]]; then mv "$previous_dir" "$install_dir"; fi
  if [[ -n "$archived_previous" && -d "$archived_previous" ]]; then mv "$archived_previous" "$previous_dir"; fi
  rm -f "$dropin_backup"
  systemctl daemon-reload
  systemctl restart "$service" || true
}

install -d -o "$target_user" -g "$target_group" "$target_home/.opencode"
stage="$(mktemp -d "$target_home/.opencode/server.new.XXXXXX")"
cp -a "$source_dir/." "$stage/"
chown -R "$target_user:$target_group" "$stage"
chmod 755 "$stage/opencode-server"

if [[ -d "$install_dir" ]]; then
  if [[ -d "$previous_dir" ]]; then
    install -d -o "$target_user" -g "$target_group" "$backup_dir"
    archived_previous="$backup_dir/server-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    mv "$previous_dir" "$archived_previous"
  fi
  mv "$install_dir" "$previous_dir"
  created_backup=true
fi
mv "$stage" "$install_dir"

install -d -m 755 "$dropin_dir"
cat >"$dropin" <<EOF
[Service]
ExecStart=
ExecStart=$install_dir/opencode-server --hostname=0.0.0.0 --port=$port
EOF

systemctl daemon-reload
if ! systemctl restart "$service"; then
  rollback
  exit 1
fi

ready=false
for _ in {1..30}; do
  if systemctl is-active --quiet "$service" && curl --noproxy '*' -fsS "http://127.0.0.1:$port/" | grep -qi '<!doctype html>'; then
    ready=true
    break
  fi
  sleep 1
done

if ! $ready; then
  systemctl status "$service" --no-pager || true
  rollback
  exit 1
fi

rm -f "$dropin_backup"
echo "Installed $install_dir/opencode-server and restarted $service."
if $created_backup; then
  echo "Previous artifact retained at $previous_dir."
else
  echo "No existing server artifact was present; no backup was created."
fi
if [[ -n "$archived_previous" ]]; then echo "Older backup retained at $archived_previous."; fi
systemctl status "$service" --no-pager
