import { PoolClient } from 'pg';
import { pool } from '../../shared/db';
import crypto from 'crypto';

/**
 * Insert a new challenge or return existing one (idempotency).
 * Returns the full row (including any stored response_body).
 */
export async function upsertChallenge(
  client: PoolClient,
  challengeId: string,
  requestDigest: string,
  requestBody: any,
  status: string,
  errorCode?: string,
  errorMessage?: string
) {
  const result = await client.query(
    `INSERT INTO mqtt_challenges (
        challenge_id,
        request_digest,
        request_body,
        status,
        error_code,
        error_message,
        received_at
      ) VALUES ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT (challenge_id) DO UPDATE SET
        request_body = EXCLUDED.request_body,
        request_digest = EXCLUDED.request_digest,
        status = EXCLUDED.status,
        error_code = EXCLUDED.error_code,
        error_message = EXCLUDED.error_message,
        responded_at = NOW()
      RETURNING *`,
    [challengeId, requestDigest, requestBody, status, errorCode || null, errorMessage || null]
  );
  return result.rows[0];
}

/** Store the final response payload for a challenge (idempotent). */
export async function storeChallengeResponse(
  client: PoolClient,
  challengeId: string,
  responseBody: any,
  status: string
) {
  await client.query(
    `UPDATE mqtt_challenges SET response_body = $1, status = $2, responded_at = NOW() WHERE challenge_id = $3`,
    [responseBody, status, challengeId]
  );
}

/** Retrieve a challenge record (including stored response_body). */
export async function getChallengeById(challengeId: string) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT * FROM mqtt_challenges WHERE challenge_id = $1`,
      [challengeId]
    );
    return rows[0] || null;
  } finally {
    client.release();
  }
}

/** Simple stats for MQTT status endpoint */
export async function getMqttStats() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT 
         COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed,
         COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
         COUNT(*) AS total
       FROM mqtt_challenges`
    );
    return rows[0];
  } finally {
    client.release();
  }
}
