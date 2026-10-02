import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { createPostgresOptions } from '../src/postgres-options.js';

const output = process.argv[2];
if (!output || !process.env.DATABASE_URL) {
  console.error('Usage: DATABASE_URL=... npm run waitlist:export -- <private-output.csv>');
  process.exitCode = 1;
} else {
  const pool = new pg.Pool(createPostgresOptions(process.env.DATABASE_URL));
  try {
    const result = await pool.query("SELECT value->>'email' AS email, value->>'createdAt' AS created_at, value->>'source' AS source FROM sinaloa_documents WHERE path LIKE 'waitlist/%' ORDER BY value->>'createdAt'");
    const cell = value => {
      const safe = /^[=+\-@\t\r]/.test(String(value || '')) ? `'${value}` : String(value || '');
      return `"${safe.replaceAll('"', '""')}"`;
    };
    const rows = [['email', 'created_at', 'source'], ...result.rows.map(row => [row.email, row.created_at, row.source])];
    await writeFile(output, `${rows.map(row => row.map(cell).join(',')).join('\r\n')}\r\n`, { flag: 'wx', mode: 0o600 });
    console.log(`Exported ${result.rowCount} waitlist entries to ${output}`);
  } finally {
    await pool.end();
  }
}
