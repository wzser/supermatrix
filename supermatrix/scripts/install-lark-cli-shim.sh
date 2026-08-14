#!/bin/bash

set -u

SCRIPT_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SHIM_PATH="$REPO_DIR/scripts/shims/lark-cli"
REAL_CLI="${SM_REAL_LARK_CLI_PATH:-$REPO_DIR/node_modules/.bin/lark-cli}"
INSTALL_PATH="${SM_LARK_CLI_SHIM_INSTALL_PATH:-$HOME/.local/bin/lark-cli}"
TEMP_LINK="$INSTALL_PATH.tmp.$$"

cleanup() {
  rm -f -- "$TEMP_LINK"
}
trap cleanup EXIT

if [[ ! -x "$SHIM_PATH" ]]; then
  echo "install-lark-cli-shim: source shim is not executable: $SHIM_PATH" >&2
  exit 1
fi

if [[ ! -x "$REAL_CLI" ]]; then
  echo "install-lark-cli-shim: real lark-cli is not executable: $REAL_CLI" >&2
  exit 1
fi

if [[ "$REAL_CLI" -ef "$SHIM_PATH" ]]; then
  echo "install-lark-cli-shim: real lark-cli resolves to the shim: $REAL_CLI" >&2
  exit 1
fi

if [[ ( -e "$INSTALL_PATH" || -L "$INSTALL_PATH" ) && ! -L "$INSTALL_PATH" ]]; then
  echo "install-lark-cli-shim: refusing to replace non-symlink: $INSTALL_PATH" >&2
  exit 1
fi

mkdir -p -- "$(dirname -- "$INSTALL_PATH")"
ln -s -- "$SHIM_PATH" "$TEMP_LINK"
mv -f -- "$TEMP_LINK" "$INSTALL_PATH"

if [[ ! -L "$INSTALL_PATH" || ! "$INSTALL_PATH" -ef "$SHIM_PATH" ]]; then
  echo "install-lark-cli-shim: installed symlink verification failed: $INSTALL_PATH" >&2
  exit 1
fi

printf 'installed lark-cli shim: %s -> %s\n' "$INSTALL_PATH" "$SHIM_PATH"
