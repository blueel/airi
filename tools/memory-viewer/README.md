# AIRI Memory Viewer

A read-only dashboard for the long-term memories that `services/memory-server` keeps in
`memory.db`. One HTML page, one Node process, zero dependencies — it talks to SQLite through
the built-in `node:sqlite` module.

## Run

```sh
# from the repository root
node --disable-warning=ExperimentalWarning tools/memory-viewer/server.mjs
```

Open <http://127.0.0.1:4320>.

The database defaults to `services/memory-server/data/memory.db`. Point it somewhere else with
`--db`, or with `MEMORY_DB_PATH`:

```sh
node --disable-warning=ExperimentalWarning tools/memory-viewer/server.mjs \
  --db ./services/memory-server/data/memory.db --port 4320 --host 127.0.0.1
```

It runs next to a live memory-server: the connection opens read-only, then sets
`PRAGMA query_only = 1`, so a browse can never change a memory. Reading a WAL database while
the owner writes is safe.

## What the page does

- **Overview** — active / pinned / general / soft-deleted counts, role count, data age.
- **Charts** — daily activity for the age of the database (max 30 days), distribution by
  `kind`, distribution by `persona`.
- **Filters** — keyword over `description` + `body`, persona, kind, pinned only, include
  deleted, time range, sort order, page size.
- **Detail panel** — full body, metadata, source session, entry id, copy-to-clipboard.
- **Export** — JSON in the app's own `airi-memory-export:v1` shape, or CSV with a BOM for
  Excel.

Shortcuts: `/` focuses the search box, `Esc` closes the panel.

## HTTP API

The page is a thin client over these endpoints, so you can also `curl` them:

```text
GET /api/meta         counts, personas, kinds, daily series, db path
GET /api/memories     ?q&persona&kind&pinned&deleted&importance&from&to&sort&limit&offset
GET /api/export       ?format=json|csv + the same filters
```

`persona=__general__` selects memories with no persona (visible to every card);
`deleted=1` includes soft-deleted rows.

## Limits

- Only the memory-server SQLite file. The browser's IndexedDB copy (`airi-memory` /
  `entries`) is not reachable from here — export it from Settings and read the JSON instead.
- One user per instance, matching the memory-server it reads.
