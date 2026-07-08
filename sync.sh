#!/usr/bin/env bash
# SHIM — logic lives in local/scripts/sync-core/. Do not edit; edit the core.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$REPO_DIR/../scripts/sync-core/sync.sh" "$REPO_DIR"
