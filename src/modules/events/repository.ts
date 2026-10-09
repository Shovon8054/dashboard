import { PoolClient } from 'pg';
import { ProductionEventPayload, EventStatus } from '../../shared/contracts';
import crypto from 'crypto';

export async function ensureSource(client: PoolClient, sourceId: string) {
  await client.query(
    `INSERT INTO production_sources (source_id, display_name) 
     VALUES ($1, $1) 
     ON CONFLICT (source_id) DO NOTHING`,
    [sourceId]
  );
}

export async function insertEvent(
  client: PoolClient,
  payload: ProductionEventPayload,
  status: EventStatus,
  voidEventId: string | null = null,
  acknowledgedAt: Date | null = null
) {
  await ensureSource(client, payload.source_id);

  const result = await client.query(
    `INSERT INTO production_events (
        event_id,
        source_id,
        type,
        quantity,
        target_event_id,
        event_time,
        status,
        void_event_id,
        acknowledged_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
    [
      payload.event_id,
      payload.source_id,
      payload.type,
      payload.quantity ?? null,
      payload.target_event_id ?? null,
      payload.event_time,
      status,
      voidEventId,
      acknowledgedAt,
    ]
  );
  return result.rows[0];
}

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
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [sourceId, eventId, JSON.stringify(rawPayload), digest, classification, error || null]
  );
}

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

export async function getPendingVoids(
  client: PoolClient,
  targetEventId: string
) {
  const { rows } = await client.query(
    `SELECT * FROM production_events 
     WHERE type = 'VOID' 
       AND target_event_id = $1 
       AND status = 'PENDING_REFERENCE' 
     ORDER BY received_at ASC, id ASC FOR UPDATE`,
    [targetEventId]
  );
  return rows;
}

export async function resolvePendingVoid(
  client: PoolClient,
  voidRowId: number,
  voidEventId: string,
  targetCountId: number
) {
  // Accept and auto-acknowledge the VOID
  await client.query(
    `UPDATE production_events 
     SET status = 'ACCEPTED', acknowledged_at = NOW() 
     WHERE id = $1`,
    [voidRowId]
  );

  // Link the COUNT to the resolving VOID
  await client.query(
    `UPDATE production_events 
     SET void_event_id = $1 
     WHERE id = $2`,
    [voidEventId, targetCountId]
  );
}

export async function rejectPendingVoid(
  client: PoolClient,
  voidRowId: number
) {
  await client.query(
    `UPDATE production_events 
     SET status = 'REJECTED' 
     WHERE id = $1`,
    [voidRowId]
  );
}
