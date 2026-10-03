# syntax=docker/dockerfile:1
#
# n8n-libpetri on the official n8n image (tasks/inject-plan.md decision 12; v1 path only).
#
# The image is the stock n8n image plus two things, both inert until activated:
#   1. the scheduler seam (patches 0001/0002, rebuilt for this release) installed into the
#      image's n8n-core by `n8n-libpetri install`, after checking every file's sha256;
#   2. a wrapper entrypoint that adds the package's EXTERNAL_HOOK_FILES entry when
#      N8N_EXECUTION_ENGINE is set, then hands over to n8n's own /docker-entrypoint.sh.
# With N8N_EXECUTION_ENGINE unset, n8n runs its own stack loop exactly as in the base image.
#
# Built from a local `npm pack` tarball by scripts/docker/build.sh, which stages the build
# context (the tarball as n8n-libpetri.tgz, plus docker/entrypoint.sh). Nothing is pushed.
#
#   scripts/docker/build.sh [n8n-version]          # default 2.41.6 -> n8n-libpetri:<ours>-n8n<version>
#
# The install runs at build time because the image's node_modules are owned by root.

ARG N8N_VERSION=2.41.6
FROM n8nio/n8n:${N8N_VERSION}
ARG N8N_VERSION

# Extra flags for `n8n-libpetri install`. The shipped seams carry a passing release-neutrality
# record, so none is needed. `--allow-unverified` installs seams without one (the record and
# `status` then say so); leaving it empty keeps the installer's refusal of such seams.
ARG N8N_LIBPETRI_INSTALL_FLAGS=""

USER root
COPY n8n-libpetri.tgz /tmp/n8n-libpetri.tgz
RUN set -eu; \
    npm install --global /tmp/n8n-libpetri.tgz --no-audit --no-fund --loglevel=error; \
    rm /tmp/n8n-libpetri.tgz; \
    npm cache clean --force >/dev/null 2>&1 || true; \
    n8n-libpetri install --n8n /usr/local/lib/node_modules/n8n ${N8N_LIBPETRI_INSTALL_FLAGS}; \
    n8n-libpetri status --n8n /usr/local/lib/node_modules/n8n > /tmp/n8n-libpetri-status.txt; \
    cat /tmp/n8n-libpetri-status.txt; \
    grep -qx 'state: installed' /tmp/n8n-libpetri-status.txt; \
    rm /tmp/n8n-libpetri-status.txt

COPY --chmod=0755 entrypoint.sh /n8n-libpetri-entrypoint.sh

LABEL org.opencontainers.image.title="n8n with n8n-libpetri" \
      org.opencontainers.image.description="The official n8n ${N8N_VERSION} image with n8n-libpetri, an alternative intra-workflow scheduler, installed and inactive until N8N_EXECUTION_ENGINE=libpetri" \
      org.opencontainers.image.source="https://github.com/debe/n8n-libpetri"

USER node
ENTRYPOINT ["tini", "--", "/n8n-libpetri-entrypoint.sh"]
