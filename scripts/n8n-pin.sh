# n8n-pin.sh: the n8n commit this repository integrates against. Sourced, never run.
#
# One definition for bootstrap-n8n.sh, verify-patch.sh and check-n8n-drift.sh, so the pin
# cannot drift between them.
#
# The pin is n8n master. Engine v2 (`packages/@n8n/engine`), which this project now targets
# first (ADR 0013), moves on master well ahead of the release branches. `git fetch <sha>` reaches
# any reachable sha, because GitHub serves it via upload-pack. The sha must be the full object
# id: abbreviations are not resolved server-side.
#
# master 944afe5, 2026-10-02 ("Run workflow history pruning as a durable system task", #40106).
# Earlier pins: the release n8n@2.41.3 (7f7a8ac, 2026-09-25), and master 441970b (2026-09-04).
N8N_TAG="master@944afe5"
N8N_COMMIT="944afe5c889f130ac07c1831dd88fa7c7103a5c1"
