export async function writeAuditLog(
  db: D1Database,
  entry: {
    actor_user_id?: string | null;
    action: string;
    target: string;
    ip?: string | null;
    meta?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    const id = `audit-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const ts = new Date().toISOString();
    const metaJson = entry.meta ? JSON.stringify(entry.meta) : null;
    await db
      .prepare(
        `INSERT INTO audit_log (id, ts, actor_user_id, action, target, ip, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        ts,
        entry.actor_user_id ?? 'professor_key',
        entry.action,
        entry.target,
        entry.ip ?? null,
        metaJson,
      )
      .run();
  } catch (err) {
    console.warn('[writeAuditLog] Failed to write audit log:', err);
  }
}

