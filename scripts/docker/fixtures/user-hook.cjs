'use strict';
// A user's own EXTERNAL_HOOK_FILES entry, for smoke leg 3: the image's wrapper entrypoint must
// append n8n-libpetri's hook to it, not replace it.
process.stderr.write('[smoke] user hook loaded\n');
module.exports = {};
