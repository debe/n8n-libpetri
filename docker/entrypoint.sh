#!/bin/sh
#
# n8n-libpetri's wrapper around n8n's /docker-entrypoint.sh (tasks/inject-plan.md decision 12).
#
# When N8N_EXECUTION_ENGINE is non-empty, appends the package's preload to NODE_OPTIONS and its
# hook file to EXTERNAL_HOOK_FILES (keeping any options and hook files the user set, with n8n's
# own separator), so activation is one variable. The preload registers the scheduler before n8n
# runs anything (divergence row 40) and checks the value: `libpetri` registers, anything else
# stops n8n with a message. The hook confirms the registration. Unset or empty leaves the
# environment alone and the container runs stock n8n. The Dockerfile also sets both variables,
# so an image run without this wrapper still loads them; a user's own value replaces that
# default, and this wrapper is what appends ours to it.
set -eu

HOOK=/usr/local/lib/node_modules/n8n-libpetri/hook/n8n-hook.cjs
PRELOAD=/usr/local/lib/node_modules/n8n-libpetri/hook/n8n-preload.mjs

if [ -n "${N8N_EXECUTION_ENGINE:-}" ]; then
  case " ${NODE_OPTIONS:-} " in
    *" --import=${PRELOAD} "*) ;;
    *) NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--import=${PRELOAD}" ;;
  esac
  export NODE_OPTIONS
  sep="${EXTERNAL_HOOK_FILES_SEPARATOR:-:}"
  case "${sep}${EXTERNAL_HOOK_FILES:-}${sep}" in
    *"${sep}${HOOK}${sep}"*) ;;
    *) EXTERNAL_HOOK_FILES="${EXTERNAL_HOOK_FILES:+${EXTERNAL_HOOK_FILES}${sep}}${HOOK}" ;;
  esac
  export EXTERNAL_HOOK_FILES
fi

exec /docker-entrypoint.sh "$@"
