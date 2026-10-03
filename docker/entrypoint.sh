#!/bin/sh
#
# n8n-libpetri's wrapper around n8n's /docker-entrypoint.sh (tasks/inject-plan.md decision 12).
#
# When N8N_EXECUTION_ENGINE is non-empty, appends the package's hook file to
# EXTERNAL_HOOK_FILES (keeping any hook files the user listed, with n8n's own separator), so
# activation is one variable. The hook itself checks the value: `libpetri` registers the
# scheduler, anything else stops n8n with a message. Unset or empty leaves the environment
# alone and the container runs stock n8n.
set -eu

HOOK=/usr/local/lib/node_modules/n8n-libpetri/hook/n8n-hook.cjs

if [ -n "${N8N_EXECUTION_ENGINE:-}" ]; then
  sep="${EXTERNAL_HOOK_FILES_SEPARATOR:-:}"
  case "${sep}${EXTERNAL_HOOK_FILES:-}${sep}" in
    *"${sep}${HOOK}${sep}"*) ;;
    *) EXTERNAL_HOOK_FILES="${EXTERNAL_HOOK_FILES:+${EXTERNAL_HOOK_FILES}${sep}}${HOOK}" ;;
  esac
  export EXTERNAL_HOOK_FILES
fi

exec /docker-entrypoint.sh "$@"
