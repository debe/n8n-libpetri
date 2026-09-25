# n8n-pin.sh: the n8n commit this repository integrates against. Sourced, never run.
#
# One definition for bootstrap-n8n.sh, verify-patch.sh and check-n8n-drift.sh, so the pin
# cannot drift between them.
#
# The pin is a release tag's commit. Release tags live on n8n's release branches, so the pinned
# commit is not an ancestor of master; `git fetch <sha>` still reaches it, because GitHub
# serves any reachable sha via upload-pack. The sha must be the full object id: abbreviations
# are not resolved server-side.
#
# n8n@2.41.3, tagged 2026-09-25 (the `beta` dist-tag that day). Earlier pin: master 441970b
# (2026-09-04), which every release from n8n@2.39.0 on contains.
N8N_TAG="n8n@2.41.3"
N8N_COMMIT="7f7a8ac25b87db6c30e2b3651bb8c5d3b21cdb85"
