import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";

/** 迁移目录：源码位于 src/、编译后位于 dist/src/，两种布局都指向仓库根的 migrations。 */
function migrationsDirectory(): string {
  const here = dirname(new URL(import.meta.url).pathname);
  const candidates = [join(here, "..", "migrations"), join(here, "..", "..", "migrations")];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error(`找不到迁移目录，已尝试：${candidates.join(", ")}`);
  return found;
}

/** 幂等执行迁移；每个迁移在单事务内应用并登记到 schema_migrations。 */
export function applyMigrations(database: Database.Database): string[] {
  const directory = migrationsDirectory();
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  );
  const applied: string[] = [];
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const exists = database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(file);
    if (exists) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(readFileSync(join(directory, file), "utf8"));
      database.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(file);
      database.exec("COMMIT");
      applied.push(file);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  return applied;
}
