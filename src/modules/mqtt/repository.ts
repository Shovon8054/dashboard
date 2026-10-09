import { PoolClient } from 'pg';
import { pool } from '../../shared/db';

export async function upsertChallenge(
  client: PoolClient,
  challengeId: string,
  requestDigest: string,
  requestBody: any,
  status: string,
  errorCode?: string
) {
  const result = await client.query(
    `INSERT INTO mqtt_challenges (
        challenge_id,
        request_digest,
        request_body,
        status,
        error_code,
        received_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (challenge_id) DO NOTHING
      RETURNING *`,
    [challengeId, requestDigest, JSON.stringify(requestBody), status, errorCode || null]
  );
  if (result.rows.length > 0) {
    return result.rows[0];
  }
  // If already exists, fetch existing row
  const existing = await client.query(
    `SELECT * FROM mqtt_challenges WHERE challenge_id = $1`,
    [challengeId]
  );
  return existing.rows[0];
}

export async function storeChallengeResponse(
  client: PoolClient,
  challengeId: string,
  responseBody: any,
  status: string,
  errorCode?: string
) {
  await client.query(
    `UPDATE mqtt_challenges 
     SET response_body = $1, status = $2, error_code = $3, responded_at = NOW() 
     WHERE challenge_id = $4`,
    [JSON.stringify(responseBody), status, errorCode || null, challengeId]
  );
}

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

export async function getLastChallenge() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT challenge_id, received_at, status, error_code 
       FROM mqtt_challenges 
       ORDER BY id DESC LIMIT 1`
    );
    return rows[0] || null;
  } finally {
    client.release();
  }
}

export async function getMqttStats() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT 
         COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
         COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
         COUNT(*)::int AS total
       FROM mqtt_challenges`
    );
    return {
      completed: Number(rows[0]?.completed || 0),
      failed: Number(rows[0]?.failed || 0),
      total: Number(rows[0]?.total || 0),
    };
  } finally {
    client.release();
  }
}
