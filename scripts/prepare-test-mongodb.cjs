// Downloads the mongodb-memory-server test binary once, before `node --test` starts test files in parallel.
// Without this, several test files can try to download it at the same moment on a fresh machine and fail on the
// download lock. Does nothing when the binary is already cached. Never contacts a real database.
const { MongoBinary } = require('mongodb-memory-server');

MongoBinary.getPath()
  .then(binary => { if (!binary) throw new Error('No MongoDB test binary was found or downloaded.'); })
  .catch(err => { console.error(`Could not prepare the MongoDB test binary: ${err.message}`); process.exit(1); });
