import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL;
const isRemote =
  connectionString?.includes('supabase.com') ||
  connectionString?.includes('sslmode=require');

export const pool = new Pool({
  connectionString,
  ssl: isRemote ? { rejectUnauthorized: false } : undefined,
});

// Prevent process crash on idle-connection resets (Supabase pooler drops TLS connections)
pool.on('error', (err) => {
  console.warn('pg pool idle client error (non-fatal):', err.message);
});

export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
