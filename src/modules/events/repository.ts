import { PoolClient } from 'pg';
import { ProductionEventPayload, EventStatus } from '../../shared/contracts';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

/**
 * Inserts a production event row.
 * Returns the inserted row (including generated id).
 */
export async function insertEvent(
  client: PoolClient,
  payload: ProductionEventPayload,
  status: EventStatus,
  voidEventId: string | null = null
) {
  const result = await client.query(
    `INSERT INTO production_events (
        event_id,
        source_id,
        type,
        quantity,
        target_event_id,
        event_time,
        status,
        void_event_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
    [
      payload.event_id,
      payload.source_id,
      payload.type,
      payload.quantity,
      payload.target_event_id,
      payload.event_time,
      status,
      voidEventId,
    ]
  );
  return result.rows[0];
}

/**
 * Logs every submission attempt (including rejections, duplicates, conflicts).
 */
export async function insertSubmissionAttempt(
  client: PoolClient,
  sourceId: string | null,
  eventId: string | null,
  rawPayload: any,
  classification: EventStatus,
  error?: string
) {
  const digest = crypto.createHash('sha256').update(JSON.stringify(rawPayload)).digest('hex');
  await client.query(
    `INSERT INTO submission_attempts (
        source_id,
        event_id,
        raw_payload,
        payload_digest,
        classification,
        error
      ) VALUES ($1,$2,$3,$4,$5,$6)`,
    [sourceId, eventId, rawPayload, digest, classification, error || null]
  );
}

/**
 * Finds an event by its event_id (FOR UPDATE if lock===true).
 */
export async function findEventById(
  client: PoolClient,
  eventId: string,
  lock = false
) {
  const sql = lock
    ? `SELECT * FROM production_events WHERE event_id = $1 FOR UPDATE`
    : `SELECT * FROM production_events WHERE event_id = $1`;
  const { rows } = await client.query(sql, [eventId]);
  return rows[0] || null;
}

/**
 * Retrieves pending VOID events that reference the given target COUNT event.
 * Rows are ordered by received_at so the first stored wins.
 */
export async function getPendingVoids(
  client: PoolClient,
  targetEventId: string
) {
  const { rows } = await client.query(
    `SELECT * FROM production_events 
     WHERE type = 'VOID' 
       AND target_event_id = $1 
       AND status = 'PENDING_REFERENCE' 
     ORDER BY received_at ASC FOR UPDATE`,
    [targetEventId]
  );
  return rows;
}

/**
 * Accept a VOID event and mark the corresponding COUNT as voided.
 * Updates both rows inside the same transaction.
 */
export async function acceptVoid(
  client: PoolClient,
  voidRow: any,
  countRow: any
) {
  // Update VOID status
  await client.query(
    `UPDATE production_events SET status = 'ACCEPTED', acknowledged_at = NOW() WHERE id = $1`,
    [voidRow.id]
  );
  // Link the COUNT to its void and mark voided
  await client.query(
    `UPDATE production_events SET void_event_id = $1, status = 'REJECTED' WHERE id = $2`,
    [voidRow.event_id, countRow.id]
  );
}

/**
 * Reject a VOID event (used when another VOID already resolved the COUNT or when
 * the target COUNT is missing).
 */
export async function rejectVoid(
  client: PoolClient,
  voidRow: any,
  reason: string
) {
  await client.query(
    `UPDATE production_events SET status = 'REJECTED', error = $1 WHERE id = $2`,
    [reason, voidRow.id]
  );
}

/**
 * Marks a COUNT as pending reference when its VOID arrives before the COUNT.
 */
export async function insertPendingVoid(
  client: PoolClient,
  payload: ProductionEventPayload,
  status: EventStatus = 'PENDING_REFERENCE'
) {
  return insertEvent(client, payload, status);
}

/**
 * Emits a domain event after DB commit (caller handles emission).
 */
export async function emitDomainEvents(events: Array<{ type: string; payload: any }>) {
  // Placeholder – real emission is done by the service layer after the transaction.
}
