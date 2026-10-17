#!/bin/sh
set -eu
case "$(uname -s)" in
  Darwin|Linux) ;;
  *) printf '%s\n' 'Use install.ps1 on Windows.' >&2; exit 1 ;;
esac
command -v node >/dev/null 2>&1 || { printf '%s\n' 'Install Node.js 22 or newer first.' >&2; exit 1; }
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$script_directory/install.mjs" "$@"
