import Fastify from "fastify";
import { Kysely, SqliteDialect, sql } from "kysely";
import { openRawDatabase, type EvidenceDatabase } from "./database.js";
import { applyMigrations } from "./migrate.js";
import { EvidenceService } from "./domain/evidence-service.js";
import { registerRoutes } from "./domain/routes.js";

export interface BuildAppOptions {
  clock?: () => Date;
  database?: EvidenceDatabase;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: false });
  let database: EvidenceDatabase;
  let ownsDatabase = false;

  if (options.database) {
    database = options.database;
  } else {
    const raw = openRawDatabase();
    applyMigrations(raw);
    database = new Kysely({ dialect: new SqliteDialect({ database: raw }) });
    ownsDatabase = true;
  }

  const service = new EvidenceService(database, options.clock ?? (() => new Date()));

  app.get("/health", async () => {
    await sql`SELECT 1`.execute(database);
    return { status: "ok" };
  });

  registerRoutes(app, service);

  app.addHook("onClose", async () => {
    if (ownsDatabase) await database.destroy();
  });

  return app;
}
