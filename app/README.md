# app/

The v3 TypeScript rewrite of movin-tracker (plan: `docs/movin-v3/`). The Go app
stays at the repo root until T7.

- `make -C app lint test` — lint (Biome + tsc) and tests; everything runs in
  Docker (`node:24-alpine`, pinned digest). The only prerequisite is Docker.
- `make -C app test` needs Docker Compose: it starts the compose `minio`
  service and runs the `app-test` container against it (no `.env`).
- No build step: `.ts` files are run directly by Node 24 (built-in type
  stripping); `tsc` is type-check only, with `.ts` import extensions.
- Import rule: only `src/durable/adapter.ts` may import
  `@earendil-works/pi-durable` (enforced by Biome `noRestrictedImports`).
