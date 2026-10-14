#!/usr/bin/env bash
# Runs test/vscode/smoke.ts inside the locally installed VS Code with an isolated profile.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/ws/.vscode"
chmod +x "$ROOT/test/fake-claude.js"
chmod +x "$ROOT/test/fake-codex.js"
cat > "$TMP/ws/.vscode/settings.json" <<EOF
{ "agentSessions.claudePath": "$ROOT/test/fake-claude.js", "agentSessions.codexPath": "$ROOT/test/fake-codex.js", "agentSessions.notifications": false }
EOF
CODE="${CODE_BIN:-/Applications/Visual Studio Code.app/Contents/MacOS/Code}"
env -u ELECTRON_RUN_AS_NODE "$CODE" \
  --extensionDevelopmentPath="$ROOT" \
  --extensionTestsPath="$ROOT/out/test/vscode/smoke.js" \
  --user-data-dir="$TMP/user" \
  --extensions-dir="$TMP/ext" \
  --disable-extensions \
  --disable-workspace-trust \
  --skip-welcome --skip-release-notes \
  "$TMP/ws"
