import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

async function runMigrations() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required.');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    // Migration tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations_applied (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const res = await client.query('SELECT 1 FROM migrations_applied WHERE filename = $1', [file]);
      if (res.rowCount === 0) {
        console.log(`Applying migration: ${file}...`);
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO migrations_applied (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`Applied: ${file}`);
      } else {
        console.log(`Skipping already applied: ${file}`);
      }
    }

    console.log('All migrations applied successfully.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigrations();
