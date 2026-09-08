import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Pool } from "pg";
import { createDatabasePool } from "./client.js";

type Direction = "up" | "down";

interface Migration {
  name: string;
  upPath: string;
  downPath: string;
}

const migrationsDirectory = fileURLToPath(new URL("./migrations", import.meta.url));

function migrationName(fileName: string): string | undefined {
  const match = fileName.match(/^(\d+_[a-z0-9_-]+)\.(up|down)\.sql$/);
  return match?.[1];
}

async function loadMigrations(): Promise<Migration[]> {
  const files = await readdir(migrationsDirectory);
  const names = [...new Set(files.map(migrationName).filter((name): name is string => Boolean(name)))].sort();

  return names.map((name) => ({
    name,
    upPath: join(migrationsDirectory, `${name}.up.sql`),
    downPath: join(migrationsDirectory, `${name}.down.sql`),
  }));
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS aura_schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function runMigration(pool: Pool, migration: Migration, direction: Direction): Promise<void> {
  const sqlPath = direction === "up" ? migration.upPath : migration.downPath;
  const sql = await readFile(sqlPath, "utf8");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(sql);
    if (direction === "up") {
      await client.query("INSERT INTO aura_schema_migrations (name) VALUES ($1)", [migration.name]);
    } else {
      await client.query("DELETE FROM aura_schema_migrations WHERE name = $1", [migration.name]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function migrateUp(pool: Pool, migrations: Migration[]): Promise<void> {
  const result = await pool.query<{ name: string }>(
    "SELECT name FROM aura_schema_migrations ORDER BY name",
  );
  const applied = new Set(result.rows.map((row) => row.name));

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    await runMigration(pool, migration, "up");
    console.log(`Applied ${migration.name}`);
  }
}

async function migrateDown(pool: Pool, migrations: Migration[]): Promise<void> {
  const result = await pool.query<{ name: string }>(
    "SELECT name FROM aura_schema_migrations ORDER BY applied_at DESC, name DESC LIMIT 1",
  );
  const lastApplied = result.rows[0]?.name;
  if (!lastApplied) {
    console.log("No migrations to roll back");
    return;
  }

  const migration = migrations.find(({ name }) => name === lastApplied);
  if (!migration) {
    throw new Error(`Migration ${lastApplied} is not present in the repository`);
  }

  await runMigration(pool, migration, "down");
  console.log(`Rolled back ${migration.name}`);
}

async function main(): Promise<void> {
  const direction = process.argv[2];
  if (direction !== "up" && direction !== "down") {
    throw new Error("Usage: npm run db:migrate or npm run db:rollback");
  }

  const pool = createDatabasePool();
  try {
    const migrations = await loadMigrations();
    await ensureMigrationsTable(pool);
    if (direction === "up") {
      await migrateUp(pool, migrations);
    } else {
      await migrateDown(pool, migrations);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown database migration error";
  console.error(`Database migration failed: ${message}`);
  process.exitCode = 1;
});
