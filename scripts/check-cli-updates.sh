#!/usr/bin/env bash
# Report newer coding-agent CLI versions than the ones pinned in crates/executors, and run the
# Codex live protocol test against the latest Codex installed in a scratch prefix.
# Never touches global installs or live presets.
set -euo pipefail
cd "$(dirname "$0")/.."
pin() { rg -o "$1@[0-9][0-9.]*" crates/executors/src -N --no-filename | head -1 | sed "s|$1@||"; }
for pkg in @openai/codex @anthropic-ai/claude-code @google/gemini-cli; do
  pinned=$(pin "$pkg"); latest=$(npm view "$pkg" version)
  printf '%-28s pinned=%-10s latest=%s %s\n' "$pkg" "$pinned" "$latest" "$([ "$pinned" = "$latest" ] && echo OK || echo UPDATE)"
done
latest=$(npm view @openai/codex version); prefix="$HOME/.local/cli-latest/codex-$latest"
[ -x "$prefix/node_modules/.bin/codex" ] || npm install --silent --prefix "$prefix" "@openai/codex@$latest"
if ! "$prefix/node_modules/.bin/codex" --version; then echo "codex $latest failed to run (XProtect?) - skip"; exit 1; fi
CODEX_BIN="$prefix/node_modules/.bin/codex" CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/dev/vk-compat-target}" \
  cargo test -p executors codex_live -- --ignored --nocapture
