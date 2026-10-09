# AI_USAGE.md

## Where AI (Antigravity / Gemini) Was Used

This project was built during a timed assessment with AI assistance. Below is an honest account of what the AI generated, what I reviewed, and what I changed myself.

---

### AI-Generated (with my direction and review)

| Area | What AI produced |
|------|-----------------|
| Project scaffold | `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, directory structure |
| Database schema | `migrations/001_initial_schema.sql` — all four tables, CHECK constraints, partial UNIQUE indexes |
| Migration runner | `scripts/migrate.ts` — reads and executes `.sql` files in order |
| Shared utilities | `src/shared/db.ts` (Pool + withTransaction), `src/shared/contracts.ts`, `src/shared/domain_events.ts` |
| Events module | `src/modules/events/service.ts`, `validation.ts`, `repository.ts`, `routes.ts` |
| Ack module | `src/modules/ack/service.ts`, `repository.ts`, `routes.ts` |
| State module | `src/modules/state/queries.ts`, `routes.ts` |
| MQTT module | `src/modules/mqtt/worker.ts`, `service.ts`, `protocol.ts`, `repository.ts`, `status.ts`, `routes.ts` |
| Express entry | `src/index.ts` — middleware, router mounts, error handler |
| Frontend | `frontend/src/api.ts`, `App.tsx`, `types.ts`, `index.css`, `vite.config.ts` (proxy config) |
| Integration tests | `tests/integration.test.ts` — 8 test cases with DB assertions |
| Documentation | `README.md`, `TECHNICAL_EXPLANATION.md`, this file |

---

### What I Reviewed and Verified

- Read every generated file before running it
- Ran `npm run migrate` and confirmed all four tables were created in PostgreSQL
- Started the backend (`npm run dev`) and verified the server started without errors
- Ran `npm test` and watched all 8 tests pass against the real Supabase database
- Opened the frontend at `http://localhost:5173` and verified the dashboard loaded live data
- Manually submitted COUNT and VOID events via the dashboard form and confirmed results appeared
- Checked MQTT worker logs to confirm connection to `152.42.238.142:1883` and subscription

---

### What I Changed or Fixed Myself

- **Fixed `state/routes.ts` bug**: The initial version had a TypeScript type error with the `return` statement inside an async route handler; I corrected the early-return pattern to satisfy the TypeScript compiler.
- **Fixed `state/queries.ts` 500 error on `?view=exceptions`**: The `submission_attempts` table query was missing source-filter parameter alignment; I fixed the conditional `$1` parameter injection to match the param array length.
- **Provided real credentials**: Supplied the actual Supabase `DATABASE_URL` and `CANDIDATE_ID=16` to connect to the live database.
- **Verified the `.env.example`** contains no real secrets — placeholder values only.

---

### What Was Not AI-Generated

- The business requirements and acceptance criteria (provided by the assessment)
- The decision to use `pg_advisory_xact_lock` for per-event_id serialization (I asked AI to implement it and understood why it was necessary)
- Database credentials and MQTT broker address (provided externally)
- The choice to keep all COUNT/VOID logic in a single `service.ts` with no duplication
