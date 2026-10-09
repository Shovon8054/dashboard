import { PoolClient } from 'pg';

/**
 * Retrieves a production_events row for the given event_id with a FOR UPDATE lock.
 * Returns null if not found.
 */
export async function lockEventForAck(
  client: PoolClient,
  eventId: string
) {
  const { rows } = await client.query(
    `SELECT * FROM production_events WHERE event_id = $1 FOR UPDATE`,
    [eventId]
  );
  return rows[0] ?? null;
}

/**
 * Marks the given COUNT event as acknowledged.
 */
export async function markAcknowledged(
  client: PoolClient,
  eventId: string
) {
  await client.query(
    `UPDATE production_events SET acknowledged_at = NOW() WHERE event_id = $1`,
    [eventId]
  );
}
