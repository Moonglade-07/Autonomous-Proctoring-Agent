/**
 * worker/utils/audit.ts — Centralized Audit Logging
 * ─────────────────────────────────────────────────────────────────────────────
 * Action and target are NOT NULL.
 * id is crypto.randomUUID().
 * ts is ISO-8601 UTC string.
 * All writes are wrapped in try/catch so a failure is logged and NEVER fails
 * or slows down the triggering request.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface AuditEntry {
  actor_user_id?: string | null;
  action: string;
  target?: string | null;
  ip?: string | null;
  meta?: Record<string, unknown> | null;
}

export async function writeAudit(
  env: { DB?: D1Database },
  entry: AuditEntry,
): Promise<void> {
  if (!env?.DB) return;
  try {
    const id = crypto.randomUUID();
    const ts = new Date().toISOString();
    const target = (entry.target && entry.target.trim().length > 0) ? entry.target.trim() : '-';
    const metaJson = entry.meta ? JSON.stringify(entry.meta) : null;

    await env.DB
      .prepare(
        `INSERT INTO audit_log (id, ts, actor_user_id, action, target, ip, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        ts,
        entry.actor_user_id ?? null,
        entry.action,
        target,
        entry.ip ?? null,
        metaJson,
      )
      .run();
  } catch (err) {
    console.warn('[writeAudit] Failed to insert audit log entry:', err);
  }
}

// Backward compatibility alias for earlier phases
export const writeAuditLog = (
  db: D1Database,
  entry: AuditEntry,
): Promise<void> => writeAudit({ DB: db }, entry);
