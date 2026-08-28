# Heroku runs `npm run build` automatically for a Node app that defines a build script,
# so this only has to name the process that serves. `npm start` runs dist/src/server.js,
# which publishes the seeded batch before listening (see publishSeededBatchIfMissing).
#
# The app must be given a database. Attach a Postgres add-on so DATABASE_URL is set, and set
# REQUIRE_DATABASE=true so a missing one is a startup failure rather than a silent fall back to
# memory storage, which loses every case and audit record on each dyno restart.
web: npm start
