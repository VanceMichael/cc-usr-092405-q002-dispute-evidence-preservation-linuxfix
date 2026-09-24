import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

export interface CaseRow {
  id: string;
  case_no: string;
  title: string;
  dispute_scope: string;
  status: "open" | "frozen" | "delivered" | "closed";
  retention_until: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DeadlineRow {
  id: string;
  case_id: string;
  kind: string;
  due_at: string;
  reason: string | null;
  extended_from_id: string | null;
  status: "active" | "superseded";
  created_by: string;
  created_at: string;
}

export interface EvidenceItemRow {
  id: string;
  case_id: string;
  source_key: string;
  source_native_id: string;
  title: string;
  status: "admitted" | "quarantined";
  current_record_id: string | null;
  in_frozen_manifest: number;
  first_collected_at: string;
}

export interface EvidenceRecordRow {
  id: string;
  item_id: string;
  content: Buffer;
  media_type: string;
  source_summary: string;
  content_hash: string;
  collected_by: string;
  collected_at: string;
}

export interface CustodyEventRow {
  id: string;
  record_id: string | null;
  item_id: string;
  event_type: "ingested" | "resent_dedup" | "variant_quarantined" | "quarantine_resolved" | "linked_fact";
  actor_id: string;
  detail: string;
  created_at: string;
}

export interface FrozenManifestRow {
  id: string;
  case_id: string;
  scope_snapshot: string;
  manifest_hash: string;
  missing_items: string;
  frozen_by: string;
  frozen_at: string;
}

export interface ManifestEntryRow {
  id: string;
  manifest_id: string;
  item_id: string;
  record_id: string;
  record_hash: string;
}

export interface LinkedFactRow {
  id: string;
  case_id: string;
  record_id: string;
  relates_to_item_id: string | null;
  kind: "correction" | "withdrawal" | "supplement";
  note: string;
  created_by: string;
  created_at: string;
}

export interface ReviewRow {
  id: string;
  case_id: string;
  manifest_id: string;
  decision: "complete" | "incomplete";
  note: string;
  reviewer_id: string;
  created_at: string;
}

export interface RedactionRow {
  id: string;
  case_id: string;
  manifest_id: string;
  rules: string;
  status: "approved" | "superseded";
  approved_by: string;
  approved_at: string;
}

export interface PackageRow {
  id: string;
  case_id: string;
  manifest_id: string;
  redaction_id: string;
  package_hash: string;
  missing_items: string;
  released_by: string;
  created_at: string;
}

export interface PackageEntryRow {
  id: string;
  package_id: string;
  item_id: string;
  source_record_id: string;
  source_record_hash: string;
  delivered_hash: string;
  changed_fields: string;
}

export interface PackageLinkedFactRow {
  id: string;
  package_id: string;
  linked_fact_id: string;
  record_id: string;
  kind: "correction" | "withdrawal" | "supplement";
  relates_to_item_id: string | null;
  note: string;
  source_record_hash: string;
  delivered_hash: string;
  changed_fields: string;
}

export interface DownloadGrantRow {
  id: string;
  package_id: string;
  token_hash: string;
  status: "active" | "revoked";
  expires_at: string;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

export interface LegalHoldRow {
  id: string;
  case_id: string;
  reason: string;
  created_by: string;
  created_at: string;
  released_at: string | null;
  released_by: string | null;
}

export interface CleanupRunRow {
  id: string;
  detail: string;
  actor_id: string;
  created_at: string;
}

export interface AccessLogRow {
  id: string;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  outcome: string;
  detail: string;
  created_at: string;
}

interface DatabaseSchema {
  service_state: { key: string; value: string; updated_at: string };
  source_registry: { source_key: string; display_name: string; created_at: string };
  cases: CaseRow;
  deadlines: DeadlineRow;
  evidence_items: EvidenceItemRow;
  evidence_records: EvidenceRecordRow;
  custody_events: CustodyEventRow;
  frozen_manifests: FrozenManifestRow;
  manifest_entries: ManifestEntryRow;
  linked_facts: LinkedFactRow;
  reviews: ReviewRow;
  redactions: RedactionRow;
  packages: PackageRow;
  package_entries: PackageEntryRow;
  package_linked_facts: PackageLinkedFactRow;
  download_grants: DownloadGrantRow;
  legal_holds: LegalHoldRow;
  cleanup_runs: CleanupRunRow;
  access_logs: AccessLogRow;
}

export function databasePath(): string {
  return process.env.DATABASE_PATH ?? "data/consumer_disputes.sqlite3";
}

export function openRawDatabase(): Database.Database {
  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");
  return database;
}

export function openDatabase(): Kysely<DatabaseSchema> {
  return new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({ database: openRawDatabase() }),
  });
}

/** 进程内共享连接：better-sqlite3 同步且线程安全，避免每请求新建句柄。 */
let sharedRaw: Database.Database | null = null;
let sharedKysely: Kysely<DatabaseSchema> | null = null;

export function getSharedRawDatabase(): Database.Database {
  sharedRaw ??= openRawDatabase();
  return sharedRaw;
}

export function getSharedDatabase(): Kysely<DatabaseSchema> {
  if (!sharedKysely) {
    sharedKysely = new Kysely<DatabaseSchema>({
      dialect: new SqliteDialect({ database: getSharedRawDatabase() }),
    });
  }
  return sharedKysely;
}

export type EvidenceDatabase = Kysely<DatabaseSchema>;
