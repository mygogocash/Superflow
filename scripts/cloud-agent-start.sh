#!/usr/bin/env bash
#
# Cloud Agent start phase: (re)start the local PostgreSQL cluster each boot and
# wait until it accepts connections. Idempotent — a no-op if already running.
# The DB *data* lives on disk (captured by the environment snapshot); only the
# server process needs to be started per boot.
set -euo pipefail

PG_VER="${PG_VER:-16}"

if ! command -v pg_ctlcluster >/dev/null 2>&1; then
  echo "[start] PostgreSQL not installed yet; run scripts/cloud-agent-install.sh first" >&2
  exit 0
fi

status="$(sudo pg_ctlcluster "$PG_VER" main status 2>/dev/null || true)"
if ! echo "$status" | grep -q "online"; then
  echo "[start] Starting PostgreSQL ${PG_VER} cluster 'main'"
  sudo pg_ctlcluster "$PG_VER" main start || true
fi

# Wait for readiness (max ~30s).
for i in $(seq 1 30); do
  if sudo -u postgres pg_isready -q; then
    echo "[start] PostgreSQL is ready"
    exit 0
  fi
  sleep 1
done
echo "[start] PostgreSQL did not become ready in time" >&2
exit 1
