# @proj-airi/memory-server

Local long-term memory service for AIRI. It stores memories in one SQLite file, so a phone and a desktop that open the same stage-web origin read the same data.

This service is for one person on one machine. It is not a hosted multi-tenant memory platform.

## Run

```sh
MEMORY_TOKEN=change-me \
MEMORY_DB_PATH=./data/memory.db \
MEMORY_PORT=4319 \
pnpm -F @proj-airi/memory-server dev
```

The server listens on `127.0.0.1` by default. Put a reverse proxy or tunnel in front of it. Do not expose it without `MEMORY_TOKEN`.

## Environment

| Name | Default | Meaning |
| --- | --- | --- |
| `MEMORY_HOST` | `127.0.0.1` | Bind address. Keep this loopback unless a proxy needs another value. |
| `MEMORY_PORT` | `4319` | HTTP port. |
| `MEMORY_DB_PATH` | `./data/memory.db` | SQLite file. The directory is created when missing. Use a path that you back up. |
| `MEMORY_TOKEN` | required | Bearer token. Every request except `/health` needs `Authorization: Bearer <token>`. |
| `MEMORY_ALLOWED_ORIGINS` | unset | Comma-separated CORS origins. Unset allows every origin. |

## API

```text
GET    /health
GET    /memory?persona=...&kind=...&limit=...
POST   /memory
PATCH  /memory/:id
DELETE /memory/:id
POST   /memory/:id/make-general
POST   /memory/search
POST   /memory/forget
POST   /memory/remove
POST   /memory/clear
GET    /memory/export
POST   /memory/import
```

A memory has a `kind` of `profile`, `fact`, or `episode`. A `profile` is pinned and always reaches the prompt. Facts and episodes are retrieved per turn.

`persona` is the character card id. A memory without `persona` is general and every card reads it.

## Backup

Use SQLite's backup command. Copying a live WAL database can miss recent writes.

```sh
sqlite3 data/memory.db ".backup 'data/memory-backup.db'"
```

Or call `GET /memory/export` and keep the JSON.

## Notes

- The server ranks memories with the shared scorer in `@proj-airi/stage-shared/memory-search`.
- Search updates `last_used_at` and `use_count` for the returned entries.
- `DELETE` and `forget` keep a soft-deleted row. `clear` removes every row.
- The service has no user accounts. Use one token for your own devices.
