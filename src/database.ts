import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

export interface PreservationCaseRow {
  id: string;
  dispute_scope: string;
  status: "open" | "released" | "closed";
  created_by: string;
  deadline_at: string;
  legal_hold: number;
  legal_hold_at: string | null;
  legal_hold_reason: string | null;
  frozen_at: string | null;
  released_at: string | null;
  closed_at: string | null;
  created_at: string;
}

interface DatabaseSchema {
  service_state: {
    key: string;
    value: string;
    updated_at: string;
  };
  source_registry: {
    source_key: string;
    display_name: string;
    created_at: string;
  };
  preservation_cases: PreservationCaseRow;
  case_deadline_extensions: {
    id: string;
    case_id: string;
    new_deadline_at: string;
    reason: string;
    requested_by: string;
    created_at: string;
  };
  material_records: {
    id: string;
    case_id: string;
    external_key: string;
    source_type: "email_attachment" | "hotline_transcript" | "merchant_supplement";
    created_by: string;
    created_at: string;
  };
  material_versions: {
    id: string;
    material_id: string;
    version_no: number;
    content_hash: string;
    content: Buffer;
    media_type: string | null;
    source_summary: string;
    collected_at: string;
    received_batch: string | null;
    submitted_by: string;
    status: "current" | "quarantined" | "superseded" | "rejected" | "linked";
    created_at: string;
  };
  custody_events: {
    id: string;
    case_id: string;
    material_id: string | null;
    version_id: string | null;
    event_type: string;
    detail: string;
    actor: string;
    created_at: string;
  };
  manifests: {
    id: string;
    case_id: string;
    digest: string;
    frozen_by: string;
    frozen_at: string;
  };
  manifest_items: {
    id: string;
    manifest_id: string;
    material_id: string;
    version_id: string;
  };
  post_freeze_facts: {
    id: string;
    case_id: string;
    manifest_id: string;
    fact_type: "correction" | "withdrawal" | "supplement";
    material_id: string | null;
    version_id: string | null;
    external_ref: string | null;
    summary: string;
    content_hash: string | null;
    content: Buffer | null;
    submitted_by: string;
    created_at: string;
  };
  manifest_business_reviews: {
    id: string;
    manifest_id: string;
    reviewer: string;
    comment: string | null;
    created_at: string;
  };
  review_drafts: {
    id: string;
    case_id: string;
    stage: "business" | "privacy";
    author: string;
    body: string;
    created_at: string;
    updated_at: string;
  };
  delivery_packages: {
    id: string;
    case_id: string;
    manifest_id: string;
    version_no: number;
    digest: string;
    status: "draft" | "approved" | "released" | "superseded";
    prepared_by: string;
    released_by: string | null;
    released_at: string | null;
    created_at: string;
  };
  package_redactions: {
    id: string;
    package_id: string;
    material_id: string;
    version_id: string;
    redacted_hash: string;
    redacted_content: Buffer;
    change_summary: string;
  };
  package_missing_items: {
    id: string;
    package_id: string;
    expected_ref: string;
    reason: string;
  };
  package_privacy_approvals: {
    id: string;
    package_id: string;
    officer: string;
    digest: string;
    comment: string | null;
    created_at: string;
  };
  download_links: {
    id: string;
    case_id: string;
    package_id: string;
    token_hash: string;
    issued_by: string;
    issued_at: string;
    expires_at: string | null;
    revoked_at: string | null;
    revoked_by: string | null;
  };
  access_logs: {
    id: string;
    case_id: string | null;
    action: string;
    actor: string;
    detail: string;
    created_at: string;
  };
  cleanup_runs: {
    id: string;
    actor: string;
    older_than: string;
    deleted_count: number;
    skipped_hold_count: number;
    started_at: string;
    finished_at: string;
  };
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
  return database;
}

export function openDatabase(): Kysely<DatabaseSchema> {
  return new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({ database: openRawDatabase() }),
  });
}

export type EvidenceDatabase = Kysely<DatabaseSchema>;
