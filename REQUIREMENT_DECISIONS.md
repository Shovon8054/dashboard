# REQUIREMENT_DECISIONS.md

This document records every assumption, interpretation, and decision made where
the specification was silent or ambiguous. An examiner reading this file should
understand why the system behaves as it does in edge cases.

---

## 1. source_id must pre-exist in production_sources

**Requirement:** Events have a `source_id` field.  
**Decision:** A foreign-key constraint (`production_events.source_id REFERENCES production_sources`) is enforced at the database level. An event with an unknown `source_id` is rejected with a validation error before any DB write.  
**Reason:** Without this constraint, orphaned events would be invisible in per-source aggregations. The test suite seeds `production_sources` rows before inserting events.

---

## 2. Duplicate detection compares five fields (not just event_id)

**Requirement:** "Identical duplicate" should be detected.  
**Decision:** Two submissions with the same `event_id` are compared on: `source_id`, `type`, `quantity` (numeric-normalised), `target_event_id`, and `event_time` (ISO-normalised). All five must match → **DUPLICATE**. Any difference → **CONFLICT**.  
**Reason:** The spec says "same ID + same body = DUPLICATE" and "same ID + changed body = CONFLICT". These five fields constitute the full business identity of an event.

---

## 3. Only one VOID can reverse a COUNT; subsequent pending VOIDs are rejected

**Requirement:** VOID reverses a COUNT.  
**Decision:** A partial UNIQUE index `ON production_events (target_event_id) WHERE type='VOID' AND status='ACCEPTED'` enforces at the DB level that at most one accepted VOID can target any COUNT. When a COUNT arrives and multiple pending VOIDs are waiting for it, the **first by insertion order** wins; the rest are marked REJECTED.  
**Reason:** Allowing two VOIDs to reverse the same COUNT would double-subtract from `net_total`, which is a business error.

---

## 4. VOID auto-acknowledged at insert time; COUNT requires explicit ack

**Requirement:** Pending acknowledgement concept applies to production events.  
**Decision:** An accepted VOID is auto-acknowledged (`acknowledged_at = NOW()`) at insert time. Only accepted COUNTs appear in the "pending ack" queue.  
**Reason:** VOIDs are correction events; they don't represent physical output and don't need operator sign-off. COUNTs represent garments produced, so they require a human acknowledgement step.

---

## 5. MQTT challenge expiry is validated server-side before any processing

**Requirement:** "Reject expired … BEFORE processing".  
**Decision:** `expires_at` is parsed as a UTC timestamp and compared to `Date.now()` immediately after JSON parse. If expired, a `FAILED / EXPIRED_CHALLENGE` response is published and no events are written to the DB.  
**Reason:** Processing expired challenges could corrupt audit state if the same events are resubmitted in a valid challenge later.

---

## 6. Idempotency key for MQTT challenges is (challenge_id + SHA-256 of normalised payload)

**Requirement:** "Same ID + same body → republish, do NOT reprocess".  
**Decision:** `request_digest = SHA-256(JSON.stringify(parsedPayload))` is stored in `mqtt_challenges`. On a re-delivery, if `stored.request_digest === incoming_digest`, the stored `response_body` is republished without calling `processBatch()`. If the digests differ, a `CHALLENGE_CONFLICT` is returned.  
**Reason:** JSON.stringify on the parsed (not raw) payload normalises whitespace and key ordering differences that would otherwise cause false conflicts.

---

## 7. net_total counts only accepted, un-voided COUNTs

**Requirement:** "net total" KPI.  
**Decision:** `net_total = SUM(quantity) WHERE type='COUNT' AND status='ACCEPTED' AND void_event_id IS NULL`.  
**Reason:** A COUNT that has been reversed by a VOID should not contribute to the total. `void_event_id IS NULL` is the flag that the COUNT is still "live".

---

## 8. processed_events excludes PENDING_REFERENCE events

**Requirement:** "Processed events" KPI.  
**Decision:** `processed_events = COUNT(*) WHERE status <> 'PENDING_REFERENCE'`.  
**Reason:** A PENDING_REFERENCE VOID has not been resolved yet and therefore has not been truly "processed" in a business sense. It is counted in `unresolved` instead.

---

## 9. API never exposes stack traces or raw SQL errors

**Requirement:** No secrets or SQL errors exposed.  
**Decision:** The central Express error handler (`src/index.ts`) returns `"Internal server error"` for any 500-level error. The actual error is only logged to `console.error` (server-side). Client-facing 4xx errors use the `err.message` set by the route handler, which is always a controlled string.  
**Reason:** Stack traces and SQL messages can leak schema details or credentials.

---

## 10. Tests run against the real database; no mocking

**Requirement:** "Runnable automated tests against a real test PostgreSQL database".  
**Decision:** `vitest` tests import `pool` from `src/shared/db.ts` and hit the same Supabase instance configured in `.env`. Each test truncates all tables in `beforeEach`. No in-memory SQLite or mock layer is used.  
**Reason:** The spec explicitly requires a real PostgreSQL database. Mocking the DB would not test constraint behaviour, advisory locks, or transaction rollback semantics.

---

## 11. Frontend dev proxy avoids CORS issues

**Requirement:** Dashboard connected to real backend with no mock data.  
**Decision:** `vite.config.ts` proxies all `/api/*` requests to `http://localhost:3000`. The frontend makes no cross-origin requests in development.  
**Reason:** Simplest zero-config CORS solution for a dev environment; no extra headers or backend configuration needed.

---

## 12. MQTT worker skipped if CANDIDATE_ID is placeholder

**Requirement:** CANDIDATE_ID required for MQTT topics.  
**Decision:** `startMqttWorker()` exits early with a warning if `CANDIDATE_ID` is missing or equals `[my-assigned-candidate-id]`.  
**Reason:** Without a real CANDIDATE_ID the topic names are wrong. Failing fast with a log message is better than connecting and silently subscribing to the wrong topic.
