# TECHNICAL_EXPLANATION.md

## Entity Model

### production_sources
Seed table of production lines. `source_id` is a string primary key (e.g. `LINE-01`).
Foreign-keyed from `production_events`, so unknown sources are rejected at the DB level.

### production_events
Core fact table. One row per unique business event.

| Column | Purpose |
|--------|---------|
| `event_id` | Business identifier; UNIQUE enforced |
| `source_id` | FK to production_sources |
| `type` | `COUNT` or `VOID` (CHECK constraint) |
| `quantity` | Required and positive for COUNT; NULL for VOID (CHECK constraint) |
| `target_event_id` | Required for VOID; NULL for COUNT (CHECK constraint) |
| `status` | ACCEPTED, PENDING_REFERENCE |
| `void_event_id` | When a COUNT is reversed, points to the VOID event_id |
| `acknowledged_at` | Set when operator acknowledges a pending COUNT |

**Key constraints:**
- `UNIQUE (event_id)` — one row per business event
- `UNIQUE partial index on (target_event_id) WHERE type='VOID' AND status='ACCEPTED'` — prevents two VOIDs from reversing the same COUNT
- `UNIQUE partial index on (void_event_id) WHERE void_event_id IS NOT NULL` — prevents a COUNT from being linked to multiple VOIDs

### submission_attempts
Audit log of every raw inbound submission (including duplicates, conflicts, rejections).
Never updated — append-only.

| Column | Purpose |
|--------|---------|
| `classification` | ACCEPTED, DUPLICATE, CONFLICT, REJECTED, PENDING_REFERENCE |
| `payload_digest` | SHA-256 of raw payload for fast duplicate detection |
| `error` | Human-readable rejection reason |

### mqtt_challenges
Persists every MQTT challenge received, its digest, and the full response payload.
Used for idempotency: if the same `challenge_id` with the same body arrives twice,
the stored `response_body` is republished directly without reprocessing.

---

## Module and Function Boundaries

### `src/shared/db.ts`
- `pool` — singleton `pg.Pool`; all modules share it
- `withTransaction(callback)` — acquires a client, begins a transaction, runs `callback(client)`, commits on success, rolls back on error, always releases the client

### `src/shared/domain_events.ts`
- Thin wrapper around `EventEmitter`
- `domainEventBus.emitEvent(type, payload)` — called **strictly after** `withTransaction` returns so domain events never fire on a rolled-back transaction

### `src/modules/events/service.ts`
**`processEvent(raw)`** — Single authoritative entry point for all COUNT/VOID logic:
1. Structural validation via `validateEvent()` (zod schema)
2. `withTransaction()` for the entire DB write
3. `pg_advisory_xact_lock(hashtext(event_id))` — serializes concurrent writes for the same event_id without table-level locking
4. Duplicate/conflict detection by comparing normalized field values
5. COUNT branch: insert ACCEPTED → scan for pending VOIDs → auto-resolve first matching VOID
6. VOID branch: find target COUNT → validate source match and not-already-voided → insert ACCEPTED → link void_event_id back to the COUNT row
7. If target COUNT missing: insert PENDING_REFERENCE and record attempt

**`processBatch(items[])`** — sequential loop over `processEvent`; preserves order; each item is its own transaction.

### `src/modules/ack/service.ts`
**`acknowledgeEvents(ids[])`** — single transaction for the whole batch:
- `SELECT ... FOR UPDATE` (via `lockEventForAck`) to prevent concurrent double-acks
- Returns per-id: ACKED, ALREADY_ACKED, NOT_FOUND, NOT_READY

### `src/modules/state/queries.ts`
Pure read queries. Three views:
- `getSummary()` — aggregate query: net_total (accepted COUNTs minus voided), processed_events, pending_ack, unresolved, duplicates, conflicts
- `getPending()` — COUNT events that are ACCEPTED and not yet acknowledged
- `getExceptions()` — union of unresolved VOIDs + rejected attempts + conflict attempts

### `src/modules/mqtt/worker.ts`
Outbound MQTT client (not a broker). Handles:
- Connect with explicit clientId `fse01-{CANDIDATE_ID}-{random}`
- MQTT 3.1.1 (`protocolVersion: 4`)
- Last-will OFFLINE payload
- Exponential backoff reconnect (doubles each attempt, capped at 30 s)
- 30-second HEARTBEAT interval
- Delegates all message processing to `handleMqttChallenge()`

### `src/modules/mqtt/service.ts`
**`handleMqttChallenge(message)`**:
1. Envelope validation (protocol_version, candidate_id, expires_at, command, events array)
2. DB idempotency: same challenge_id + same body → republish stored response; same challenge_id + different body → CHALLENGE_CONFLICT
3. Process events via the exact same `processBatch()` used by the REST endpoint
4. Build and store response; publish to `.../response` topic

**`getMqttStatus()`** — merges in-memory runtime state with DB stats for a durable view that survives restarts

---

## Transaction and Duplicate Strategy

Each event submission is wrapped in a single `withTransaction()` call containing:
1. Advisory lock on `hashtext(event_id)` — serializes races without a table-level lock
2. Lookup existing row — compare normalized fields
3. One of: write DUPLICATE attempt / write CONFLICT attempt / insert new event
4. Any associated updates (void resolution, linking void_event_id) happen in the same transaction

This means: either everything for one event commits or nothing does. The submission_attempts row is inside the same transaction so auditing is always consistent.

---

## Pending VOID Resolution

When a VOID arrives before its target COUNT:
- VOID is inserted with `status = PENDING_REFERENCE`
- A submission attempt with classification `PENDING_REFERENCE` is recorded

When the COUNT later arrives:
- `getPendingVoids(client, countEventId)` fetches all pending VOIDs targeting this COUNT
- The first VOID with a matching `source_id` wins: it is flipped to ACCEPTED and auto-acknowledged; the COUNT's `void_event_id` is set
- Any additional pending VOIDs for the same COUNT are rejected (COUNT can only be reversed once)

---

## Restart Behavior

All state lives in PostgreSQL. On restart:
- `production_events`, `submission_attempts`, `mqtt_challenges` contain full history
- `runtimeMqttStatus` (in-memory) is reset, but `getMqttStatus()` falls back to the most recent `mqtt_challenges` row from the DB for last challenge info
- MQTT worker reconnects automatically and resubscribes

---

## Future Microservice Migration Path

The codebase is already organized as isolated modules. A natural split:

```
Current monolith               →  Future services
────────────────────────────────────────────────────
modules/events/                →  events-service (writes)
modules/state/                 →  query-service (reads, CQRS)
modules/ack/                   →  ack-service
modules/mqtt/                  →  mqtt-service (own process)
shared/domain_events.ts        →  replace with message broker (NATS / Kafka)
```

Steps:
1. Replace `domainEventBus` (in-process EventEmitter) with publishing to a real message broker
2. Split each module into its own Node process with its own DB connection pool
3. The `state/queries.ts` read model can be maintained as a materialized view or event-sourced projection
4. MQTT worker becomes a standalone service consuming from the broker and publishing results

No domain logic is duplicated across modules today — all COUNT/VOID rules are in `events/service.ts` — so the migration boundary is already clean.

---

## Known Assumptions

- `source_id` values must exist in `production_sources` before events can be submitted (FK enforced). The test seeds `production_sources` inline.
- `event_time` is provided by the client; the server does not override it.
- A VOID can only reverse one COUNT; if multiple pending VOIDs target the same COUNT, only the first (by insertion order) wins.
- MQTT challenge expiry is validated server-side; expired challenges are rejected before any DB writes.
- Duplicate detection compares: source_id, type, quantity, target_event_id, event_time (ISO-normalized). All five must match to be a DUPLICATE; any difference is a CONFLICT.
- The `acknowledged_at` timestamp is set by the server at ack time, not provided by the client.
- Secrets (DATABASE_URL, CANDIDATE_ID) are loaded from `.env` and never exposed in API responses or logs.
