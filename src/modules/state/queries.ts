import { Pool } from 'pg';
import { pool } from '../../shared/db';
import { 
  EventStatus,
  ProductionEventRecord,
  SubmissionResult
} from '../../shared/contracts';

/**
 * Summarizes the current production state.
 * If `sourceId` is provided, all counts are filtered to that source.
 * Returns a flat object with the required metrics.
 */
export async function getSummary(sourceId?: string) {
  const client = await pool.connect();
  try {
    const srcFilter = sourceId ? 'AND source_id = $1' : '';
    const srcParam = sourceId ? [sourceId] : [];

    const summaryQuery = `
      SELECT 
        -- net_total = accepted COUNT qty minus voided COUNT qty
        COALESCE(
          SUM(CASE 
                WHEN type = 'COUNT' AND void_event_id IS NULL THEN quantity 
                ELSE 0 
              END),
          0
        ) - COALESCE(
          SUM(CASE 
                WHEN type = 'COUNT' AND void_event_id IS NOT NULL THEN quantity 
                ELSE 0 
              END),
          0
        ) AS net_total,
        -- processed events = any COUNT or VOID that is not pending reference
        COUNT(*) FILTER (WHERE type IN ('COUNT','VOID') AND status <> 'PENDING_REFERENCE') AS processed_events,
        -- pending acknowledgements = accepted COUNT not yet acked
        COUNT(*) FILTER (WHERE type = 'COUNT' AND status = 'ACCEPTED' AND acknowledged_at IS NULL) AS pending_ack,
        -- unresolved = VOIDs still waiting for their target COUNT
        COUNT(*) FILTER (WHERE type = 'VOID' AND status = 'PENDING_REFERENCE') AS unresolved,
        -- duplicates attempts count (filtered by source if supplied)
        (SELECT COUNT(*) FROM submission_attempts WHERE classification = 'DUPLICATE' ${sourceId ? "AND source_id = $1" : ''}) AS duplicates,
        -- conflict attempts count (filtered by source if supplied)
        (SELECT COUNT(*) FROM submission_attempts WHERE classification = 'CONFLICT' ${sourceId ? "AND source_id = $1" : ''}) AS conflicts
      FROM production_events
      WHERE 1=1 ${srcFilter};
    `;

    const { rows } = await client.query(summaryQuery, srcParam);
    const row = rows[0];
    return {
      net_total: Number(row.net_total),
      processed_events: Number(row.processed_events),
      pending_ack: Number(row.pending_ack),
      unresolved: Number(row.unresolved),
      duplicates: Number(row.duplicates),
      conflicts: Number(row.conflicts),
    };
  } finally {
    client.release();
  }
}

/**
 * Returns COUNT events that are ready for acknowledgement (accepted and not yet acked).
 */
export async function getPending(sourceId?: string): Promise<ProductionEventRecord[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT * FROM production_events 
       WHERE type = 'COUNT' 
         AND status = 'ACCEPTED' 
         AND acknowledged_at IS NULL
         ${sourceId ? 'AND source_id = $1' : ''}
       ORDER BY received_at ASC`,
      sourceId ? [sourceId] : []
    );
    return result.rows;
  } finally {
    client.release();
  }
}

/**
 * Returns exceptional items: unresolved VOIDs, rejected submissions, and conflict attempts.
 * Each entry contains a `type` field describing the category and a `reason`.
 */
export async function getExceptions(sourceId?: string) {
  const client = await pool.connect();
  try {
    const srcCond = sourceId ? 'AND source_id = $1' : '';
    const srcParam = sourceId ? [sourceId] : [];

    // 1️⃣ Unresolved VOIDs (still pending reference)
    const unresolvedRows = await client.query(
      `SELECT event_id, source_id, target_event_id, 'UNRESOLVED' AS type, NULL AS reason 
       FROM production_events 
       WHERE type = 'VOID' AND status = 'PENDING_REFERENCE' ${srcCond}`,
      srcParam
    );

    // 2️⃣ Rejected submissions (recorded in submission_attempts with classification REJECTED)
    const rejectedRows = await client.query(
      `SELECT event_id, source_id, error AS reason, 'REJECTED' AS type 
       FROM submission_attempts 
       WHERE classification = 'REJECTED' ${srcCond}`,
      srcParam
    );

    // 3️⃣ Conflict attempts
    const conflictRows = await client.query(
      `SELECT event_id, source_id, error AS reason, 'CONFLICT' AS type 
       FROM submission_attempts 
       WHERE classification = 'CONFLICT' ${srcCond}`,
      srcParam
    );

    const combined = [
      ...unresolvedRows.rows,
      ...rejectedRows.rows,
      ...conflictRows.rows,
    ];
    return combined;
  } finally {
    client.release();
  }
}
