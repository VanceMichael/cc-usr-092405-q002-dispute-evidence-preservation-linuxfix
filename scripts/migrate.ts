import { openRawDatabase } from "../src/database.js";
import { applyMigrations } from "../src/migrate.js";

const database = openRawDatabase();
const applied = applyMigrations(database);
for (const version of applied) console.log(`已应用迁移：${version}`);
if (applied.length === 0) console.log("数据库已是最新");
database.close();
