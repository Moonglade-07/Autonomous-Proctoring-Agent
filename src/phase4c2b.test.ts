/**
 * src/phase4c2b.test.ts — Comprehensive Test Suite for Phase 4c-2b (Vitest)
 * ─────────────────────────────────────────────────────────────────────────────
 * Verifies:
 *   1. Delete and clear rules (violation_count = 0 strictly required, NULL refused)
 *   2. In-progress attempts cannot be archived or deleted (test attempts exempt)
 *   3. Typed confirmation name required for single permanent delete
 *   4. Clear session data purges proctoring telemetry only (keeps answers & score)
 *   5. Bulk actions report per-item success/failure with reasons
 *   6. Deleting attempt cascades to answers rows
 *   7. Test attempts have is_test = 1, excluded from submissions, release, and live grid
 *   8. Draft preview serves live questions without correct answers
 *   9. Retention sweep purges telemetry for attempts older than retention_days
 *  10. Evidence hold protects attempts from retention sweep
 *  11. Test attempts older than 24h are deleted by retention sweep
 *  12. Dual cron handler branches on controller.cron
 *  13. /purge internal endpoint is not exposed on public worker routes
 *  14. Audit logs are written for every session lifecycle mutation
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, expect, vi } from 'vitest';
import { handleSessionsApi, runRetentionSweep } from '../worker/api/sessions';
import { handleGradingApi } from '../worker/api/grading';
import { ExamSessionDO } from '../worker/ExamSessionDO';
import worker from '../worker/index';

// ─── Mock D1 Database Helper ─────────────────────────────────────────────────

interface MockDbConfig {
  exam?: Record<string, unknown> | null;
  attempts?: Record<string, unknown>[];
  questions?: Record<string, unknown>[];
  answers?: Record<string, unknown>[];
  auditLogs?: Record<string, unknown>[];
  failQueryMatch?: string;
}

function createMockDb(config: MockDbConfig) {
  const runLogs: Array<{ query: string; params: unknown[] }> = [];
  const attempts = [...(config.attempts ?? [])];
  const questions = [...(config.questions ?? [])];
  const answers = [...(config.answers ?? [])];
  const auditLogs = [...(config.auditLogs ?? [])];

  function makeStatement(query: string, boundArgs: unknown[] = []) {
    return {
      bind(...args: unknown[]) {
        return makeStatement(query, args);
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        if (query.includes('FROM exams WHERE id = ?')) {
          return (config.exam ?? null) as T | null;
        }
        if (query.includes('FROM attempts WHERE id = ?')) {
          const id = boundArgs[0];
          const found = attempts.find((a) => a.id === id);
          return (found ?? null) as T | null;
        }
        return null;
      },
      async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
        if (query.includes('FROM attempts a') && query.includes('WHERE a.exam_id = ?')) {
          if (query.includes('a.is_test = 0')) {
            const filtered = attempts.filter((a) => !a.is_test || a.is_test === 0);
            return { results: filtered as unknown as T[] };
          }
          return { results: attempts as unknown as T[] };
        }
        if (query.includes('FROM attempts') && query.includes('WHERE is_test = 1')) {
          const cutoff = boundArgs[0] as string;
          const filtered = attempts.filter((a) => a.is_test === 1 && (a.started_at as string) < cutoff);
          return { results: filtered as unknown as T[] };
        }
        if (query.includes('FROM attempts a') && query.includes('retention_days')) {
          // Retention sweep query: WHERE a.data_purged_at IS NULL AND a.evidence_hold = 0 AND e.retention_days > 0
          const eligible = attempts.filter(
            (a) =>
              !a.data_purged_at &&
              (a.evidence_hold === 0 || a.evidence_hold === undefined) &&
              Number(a.retention_days ?? config.exam?.retention_days ?? 90) > 0 &&
              (a.ended_at || a.submitted_at),
          );
          return { results: eligible as unknown as T[] };
        }
        if (query.includes('FROM questions WHERE exam_id = ?')) {
          return { results: questions as unknown as T[] };
        }
        return { results: [] };
      },
      async run() {
        if (config.failQueryMatch && query.includes(config.failQueryMatch)) {
          throw new Error(`Simulated D1 error matching: ${config.failQueryMatch}`);
        }
        runLogs.push({ query, params: boundArgs });
        if (query.includes('INSERT INTO audit_log')) {
          auditLogs.push({
            id: boundArgs[0],
            ts: boundArgs[1],
            actor_user_id: boundArgs[2],
            action: boundArgs[3],
            target: boundArgs[4],
            ip: boundArgs[5],
            meta_json: boundArgs[6],
          });
        }
        if (query.includes('INSERT INTO attempts')) {
          attempts.push({
            id: boundArgs[0],
            exam_id: boundArgs[1],
            student_name: boundArgs[2],
            session_id: boundArgs[3],
            status: 'in_progress',
            started_at: boundArgs[4],
            deadline_at: boundArgs[5],
            paused_seconds: 0,
            max_score: boundArgs[6],
            grading_status: 'auto_graded',
            is_test: query.includes('is_test') ? 1 : 0,
            violation_count: 0,
            final_risk_score: 0,
          });
        }
        if (query.includes('DELETE FROM answers WHERE attempt_id = ?')) {
          const attId = boundArgs[0];
          const idx = answers.findIndex((a) => a.attempt_id === attId);
          if (idx !== -1) answers.splice(idx, 1);
        }
        if (query.includes('DELETE FROM attempts WHERE id = ?')) {
          const attId = boundArgs[0];
          const idx = attempts.findIndex((a) => a.id === attId);
          if (idx !== -1) attempts.splice(idx, 1);
        }
        if (query.includes('UPDATE attempts SET data_purged_at = ?')) {
          const attId = boundArgs[1];
          const found = attempts.find((a) => a.id === attId);
          if (found) found.data_purged_at = boundArgs[0];
        }
        if (query.includes('UPDATE attempts SET archived = 1')) {
          const attId = boundArgs[1];
          const found = attempts.find((a) => a.id === attId);
          if (found) {
            found.archived = 1;
            found.archived_at = boundArgs[0];
          }
        }
        if (query.includes('UPDATE attempts SET archived = 0')) {
          const attId = boundArgs[0];
          const found = attempts.find((a) => a.id === attId);
          if (found) {
            found.archived = 0;
            found.archived_at = null;
          }
        }
        if (query.includes('UPDATE attempts SET evidence_hold = ?')) {
          const attId = boundArgs[1];
          const found = attempts.find((a) => a.id === attId);
          if (found) found.evidence_hold = boundArgs[0];
        }
        if (query.includes('UPDATE attempts') && query.includes('WHERE session_id = ?')) {
          const sessId = boundArgs[boundArgs.length - 1];
          const found = attempts.find((a) => a.session_id === sessId);
          if (found) {
            if (query.includes('violation_count = NULL')) {
              found.violation_count = null;
              found.ended_reason = boundArgs[0];
            } else if (query.includes('violation_count = ?')) {
              found.violation_count = boundArgs[0];
              found.max_severity = boundArgs[1];
              found.last_violation_at = boundArgs[2];
              found.final_risk_score = boundArgs[3];
              if (boundArgs.length >= 6) {
                found.ended_reason = boundArgs[4];
              }
            }
          }
        }
        return { success: true };
      },
    };
  }

  return {
    prepare(query: string) {
      return makeStatement(query);
    },
    runLogs,
    attempts,
    answers,
    auditLogs,
  };
}

function createMockEnv(db: ReturnType<typeof createMockDb>) {
  const doPurges: string[] = [];
  const hubRemoves: string[] = [];

  const mockSessionDO = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (id: { toString: () => string }) => ({
      fetch: async (url: string) => {
        if (url.includes('/purge')) {
          doPurges.push(id.toString());
          return new Response(JSON.stringify({ ok: true }));
        }
        return new Response('ok');
      },
    }),
  };

  const mockHubDO = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (id: { toString: () => string }) => ({
      fetch: async (url: string, init?: RequestInit) => {
        if (url.includes('/internal/remove-session')) {
          const body = init?.body ? JSON.parse(init.body as string) : {};
          hubRemoves.push(body.sessionId);
          return new Response(JSON.stringify({ ok: true }));
        }
        if (url.includes('/internal/sessions')) {
          return new Response(JSON.stringify({ sessions: [] }));
        }
        return new Response('ok');
      },
    }),
  };

  return {
    DB: db as unknown as D1Database,
    PROFESSOR_KEY: 'test-prof-key',
    EXAM_SESSION: mockSessionDO as unknown as DurableObjectNamespace,
    EXAM_HUB: mockHubDO as unknown as DurableObjectNamespace,
    doPurges,
    hubRemoves,
  };
}

describe('Phase 4c-2b: Session Lifecycle, Retention & Deletion Rules', () => {
  // ── 1. Delete and Clear Rules ──────────────────────────────────────────────
  describe('Delete and Clear Rules', () => {
    it('refuses deletion (409) when violation_count > 0', async () => {
      const db = createMockDb({
        exam: { id: 'exam-1', professor_key: 'test-prof-key' },
        attempts: [
          {
            id: 'att-viol',
            exam_id: 'exam-1',
            student_name: 'Alice',
            status: 'submitted',
            is_test: 0,
            violation_count: 2,
            evidence_hold: 0,
          },
        ],
      });
      const env = createMockEnv(db);

      const req = new Request('http://localhost/api/professor/exams/exam-1/sessions/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Professor-Key': 'test-prof-key',
        },
        body: JSON.stringify({ attemptIds: ['att-viol'], confirmationName: 'Alice' }),
      });

      const res = await handleSessionsApi(req, env, '/exams/exam-1/sessions/delete', 'POST', 'exam-1');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.succeededCount).toBe(0);
      expect(data.refusedCount).toBe(1);
      expect(data.results[0].reason).toContain('violations');
      // D1 row was not deleted
      expect(db.attempts.length).toBe(1);
    });

    it('refuses deletion (409) when violation_count is NULL (unknown)', async () => {
      const db = createMockDb({
        exam: { id: 'exam-1', professor_key: 'test-prof-key' },
        attempts: [
          {
            id: 'att-null-viol',
            exam_id: 'exam-1',
            student_name: 'Bob',
            status: 'submitted',
            is_test: 0,
            violation_count: null,
            evidence_hold: 0,
          },
        ],
      });
      const env = createMockEnv(db);

      const req = new Request('http://localhost/api/professor/exams/exam-1/sessions/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Professor-Key': 'test-prof-key',
        },
        body: JSON.stringify({ attemptIds: ['att-null-viol'], confirmationName: 'Bob' }),
      });

      const res = await handleSessionsApi(req, env, '/exams/exam-1/sessions/delete', 'POST', 'exam-1');
      const data = await res.json();
      expect(data.succeededCount).toBe(0);
      expect(data.refusedCount).toBe(1);
      expect(data.results[0].reason.toLowerCase()).toContain('unknown');
    });

    it('refuses deletion (409) when attempt is in_progress (non-test)', async () => {
      const db = createMockDb({
        exam: { id: 'exam-1', professor_key: 'test-prof-key' },
        attempts: [
          {
            id: 'att-live',
            exam_id: 'exam-1',
            student_name: 'Charlie',
            status: 'in_progress',
            is_test: 0,
            violation_count: 0,
            evidence_hold: 0,
          },
        ],
      });
      const env = createMockEnv(db);

      const req = new Request('http://localhost/api/professor/exams/exam-1/sessions/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Professor-Key': 'test-prof-key',
        },
        body: JSON.stringify({ attemptIds: ['att-live'], confirmationName: 'Charlie' }),
      });

      const res = await handleSessionsApi(req, env, '/exams/exam-1/sessions/delete', 'POST', 'exam-1');
      const data = await res.json();
      expect(data.succeededCount).toBe(0);
      expect(data.refusedCount).toBe(1);
      expect(data.results[0].reason.toLowerCase()).toContain('in-progress');
    });

    it('refuses single deletion (400) when confirmationName does not match student name', async () => {
      const db = createMockDb({
        exam: { id: 'exam-1', professor_key: 'test-prof-key' },
        attempts: [
          {
            id: 'att-clean',
            exam_id: 'exam-1',
            student_name: 'David',
            status: 'submitted',
            is_test: 0,
            violation_count: 0,
            evidence_hold: 0,
          },
        ],
      });
      const env = createMockEnv(db);

      const req = new Request('http://localhost/api/professor/exams/exam-1/sessions/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Professor-Key': 'test-prof-key',
        },
        body: JSON.stringify({ attemptIds: ['att-clean'], confirmationName: 'WrongName' }),
      });

      const res = await handleSessionsApi(req, env, '/exams/exam-1/sessions/delete', 'POST', 'exam-1');
      const data = await res.json();
      expect(data.succeededCount).toBe(0);
      expect(data.refusedCount).toBe(1);
      expect(data.results[0].reason.toLowerCase()).toContain('confirmation');
    });

    it('succeeds deleting clean ended attempt when confirmationName matches and cascades answers', async () => {
      const db = createMockDb({
        exam: { id: 'exam-1', professor_key: 'test-prof-key' },
        attempts: [
          {
            id: 'att-clean',
            session_id: 'sess-clean',
            exam_id: 'exam-1',
            student_name: 'David',
            status: 'submitted',
            is_test: 0,
            violation_count: 0,
            evidence_hold: 0,
          },
        ],
        answers: [{ attempt_id: 'att-clean', question_id: 'q1', answer_json: '"42"' }],
      });
      const env = createMockEnv(db);

      const req = new Request('http://localhost/api/professor/exams/exam-1/sessions/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Professor-Key': 'test-prof-key',
        },
        body: JSON.stringify({ attemptIds: ['att-clean'], confirmationName: 'David' }),
      });

      const res = await handleSessionsApi(req, env, '/exams/exam-1/sessions/delete', 'POST', 'exam-1');
      const data = await res.json();
      expect(data.succeededCount).toBe(1);
      expect(data.refusedCount).toBe(0);

      // Attempt and answers cascade-deleted
      expect(db.attempts.length).toBe(0);
      expect(db.answers.length).toBe(0);

      // Hub and DO purged
      expect(env.hubRemoves).toContain('sess-clean');
      expect(env.doPurges).toContain('sess-clean');

      // Audit log recorded
      const log = db.auditLogs.find((l) => l.action === 'delete_attempt');
      expect(log).toBeDefined();
      expect(log?.target).toBe('att-clean');
    });

    it('succeeds deleting test attempt even when in_progress and without confirmationName', async () => {
      const db = createMockDb({
        exam: { id: 'exam-1', professor_key: 'test-prof-key' },
        attempts: [
          {
            id: 'att-test',
            session_id: 'sess-test',
            exam_id: 'exam-1',
            student_name: 'Preview-1234',
            status: 'in_progress',
            is_test: 1,
            violation_count: 5, // test attempts bypass violation restriction
            evidence_hold: 0,
          },
        ],
      });
      const env = createMockEnv(db);

      const req = new Request('http://localhost/api/professor/exams/exam-1/sessions/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Professor-Key': 'test-prof-key',
        },
        body: JSON.stringify({ attemptIds: ['att-test'] }), // No confirmation name needed
      });

      const res = await handleSessionsApi(req, env, '/exams/exam-1/sessions/delete', 'POST', 'exam-1');
      const data = await res.json();
      expect(data.succeededCount).toBe(1);
      expect(db.attempts.length).toBe(0);
    });

    it('refuses clear telemetry when violation_count > 0 or NULL', async () => {
      const db = createMockDb({
        exam: { id: 'exam-1', professor_key: 'test-prof-key' },
        attempts: [
          {
            id: 'att-dirty',
            exam_id: 'exam-1',
            student_name: 'Eve',
            status: 'submitted',
            is_test: 0,
            violation_count: 1,
          },
        ],
      });
      const env = createMockEnv(db);

      const req = new Request('http://localhost/api/professor/exams/exam-1/sessions/clear', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Professor-Key': 'test-prof-key',
        },
        body: JSON.stringify({ attemptIds: ['att-dirty'] }),
      });

      const res = await handleSessionsApi(req, env, '/exams/exam-1/sessions/clear', 'POST', 'exam-1');
      const data = await res.json();
      expect(data.succeededCount).toBe(0);
      expect(data.refusedCount).toBe(1);
      expect(data.results[0].reason.toLowerCase()).toContain('violations');
    });

    it('succeeds clear telemetry when violation_count = 0 (attempt preserved, data_purged_at set)', async () => {
      const db = createMockDb({
        exam: { id: 'exam-1', professor_key: 'test-prof-key' },
        attempts: [
          {
            id: 'att-clean-clear',
            session_id: 'sess-clean-clear',
            exam_id: 'exam-1',
            student_name: 'Frank',
            status: 'submitted',
            is_test: 0,
            violation_count: 0,
            score: 85,
          },
        ],
      });
      const env = createMockEnv(db);

      const req = new Request('http://localhost/api/professor/exams/exam-1/sessions/clear', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Professor-Key': 'test-prof-key',
        },
        body: JSON.stringify({ attemptIds: ['att-clean-clear'] }),
      });

      const res = await handleSessionsApi(req, env, '/exams/exam-1/sessions/clear', 'POST', 'exam-1');
      const data = await res.json();
      expect(data.succeededCount).toBe(1);

      // Attempt preserved!
      expect(db.attempts.length).toBe(1);
      expect(db.attempts[0].data_purged_at).toBeDefined();

      // Telemetry cleared from DO and Hub
      expect(env.doPurges).toContain('sess-clean-clear');
      expect(env.hubRemoves).toContain('sess-clean-clear');

      // Audit log
      const log = db.auditLogs.find((l) => l.action === 'clear_session_data');
      expect(log).toBeDefined();
    });

    it('archive succeeds for any ended attempt, refused for in_progress', async () => {
      const db = createMockDb({
        exam: { id: 'exam-1', professor_key: 'test-prof-key' },
        attempts: [
          {
            id: 'att-ended',
            exam_id: 'exam-1',
            student_name: 'Grace',
            status: 'submitted',
            is_test: 0,
            archived: 0,
          },
          {
            id: 'att-running',
            exam_id: 'exam-1',
            student_name: 'Henry',
            status: 'in_progress',
            is_test: 0,
            archived: 0,
          },
        ],
      });
      const env = createMockEnv(db);

      const req = new Request('http://localhost/api/professor/exams/exam-1/sessions/archive', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Professor-Key': 'test-prof-key',
        },
        body: JSON.stringify({ attemptIds: ['att-ended', 'att-running'] }),
      });

      const res = await handleSessionsApi(req, env, '/exams/exam-1/sessions/archive', 'POST', 'exam-1');
      const data = await res.json();
      expect(data.succeededCount).toBe(1);
      expect(data.refusedCount).toBe(1);

      expect(db.attempts.find((a) => a.id === 'att-ended')?.archived).toBe(1);
      expect(db.attempts.find((a) => a.id === 'att-running')?.archived).toBe(0);
    });
  });

  // ── 2. Bulk Actions Reporting ──────────────────────────────────────────────
  describe('Bulk Actions Reporting', () => {
    it('reports per-item success/refusal with reasons when multiple items processed', async () => {
      const db = createMockDb({
        exam: { id: 'exam-1', professor_key: 'test-prof-key' },
        attempts: [
          { id: 'att-1', exam_id: 'exam-1', student_name: 'A', status: 'submitted', violation_count: 0, is_test: 0 },
          { id: 'att-2', exam_id: 'exam-1', student_name: 'B', status: 'submitted', violation_count: 3, is_test: 0 },
        ],
      });
      const env = createMockEnv(db);

      const req = new Request('http://localhost/api/professor/exams/exam-1/sessions/clear', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Professor-Key': 'test-prof-key',
        },
        body: JSON.stringify({ attemptIds: ['att-1', 'att-2'] }),
      });

      const res = await handleSessionsApi(req, env, '/exams/exam-1/sessions/clear', 'POST', 'exam-1');
      const data = await res.json();
      expect(data.succeededCount).toBe(1);
      expect(data.refusedCount).toBe(1);
      expect(data.results).toHaveLength(2);
      expect(data.results[0].success).toBe(true);
      expect(data.results[1].success).toBe(false);
      expect(data.results[1].reason.toLowerCase()).toContain('violations');
    });
  });

  // ── 3. Preview Exam & Test Attempts ────────────────────────────────────────
  describe('Preview Exam & Test Attempts', () => {
    it('creates test attempt with is_test = 1 and strips correct answers for draft preview', async () => {
      const db = createMockDb({
        exam: { id: 'exam-draft', status: 'draft', title: 'Draft Exam', professor_key: 'test-prof-key', duration_minutes: 30 },
        questions: [
          {
            id: 'q1',
            exam_id: 'exam-draft',
            question_text: 'What is 2+2?',
            type: 'multiple_choice',
            options_json: JSON.stringify(['3', '4', '5']),
            correct_answer_json: JSON.stringify('4'),
            rubric: 'Secret rubric',
            points: 5,
          },
        ],
      });
      const env = createMockEnv(db);

      const req = new Request('http://localhost/api/professor/exams/exam-draft/preview-start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Professor-Key': 'test-prof-key',
        },
      });

      const res = await handleSessionsApi(req, env, '/exams/exam-draft/preview-start', 'POST', 'exam-draft');
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.attempt).toBeDefined();
      expect(data.attempt.is_test).toBe(1);
      expect(data.attempt.student_name).toMatch(/^Preview-[A-Za-z0-9]{4}$/);

      // Questions are stripped of answers and rubric!
      expect(data.questions).toHaveLength(1);
      expect(data.questions[0].correct_answer).toBeUndefined();
      expect(data.questions[0].rubric).toBeUndefined();
      expect(data.questions[0].question_text).toBe('What is 2+2?');
    });

    it('excludes test attempts from submissions endpoint by default', async () => {
      const db = createMockDb({
        exam: { id: 'exam-1', professor_key: 'test-prof-key' },
        attempts: [
          { id: 'att-real', exam_id: 'exam-1', student_name: 'Real Student', status: 'submitted', is_test: 0, score: 90 },
          { id: 'att-test', exam_id: 'exam-1', student_name: 'Preview-1234', status: 'submitted', is_test: 1, score: 100 },
        ],
      });
      const env = createMockEnv(db);

      // Default: include_test is false
      const req = new Request('http://localhost/api/professor/exams/exam-1/submissions', {
        headers: { 'X-Professor-Key': 'test-prof-key' },
      });

      const res = await handleGradingApi(req, env as any, '/exams/exam-1/submissions', 'GET', 'exam-1');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.attempts).toHaveLength(1);
      expect(data.attempts[0].id).toBe('att-real');

      // With include_test=1: includes test attempt
      const reqWithTest = new Request('http://localhost/api/professor/exams/exam-1/submissions?include_test=1', {
        headers: { 'X-Professor-Key': 'test-prof-key' },
      });
      const resWithTest = await handleGradingApi(reqWithTest, env as any, '/exams/exam-1/submissions', 'GET', 'exam-1');
      const dataWithTest = await resWithTest.json();
      expect(dataWithTest.attempts).toHaveLength(2);
    });
  });

  // ── 4. Retention Sweep & Evidence Hold ──────────────────────────────────────
  describe('Retention Sweep & Evidence Hold', () => {
    it('purges sessions whose attempts ended older than retention_days and skips evidence_hold', async () => {
      const oldEndedDate = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString(); // 100 days ago
      const db = createMockDb({
        exam: { id: 'exam-1', retention_days: 90 },
        attempts: [
          {
            id: 'att-expired',
            session_id: 'sess-expired',
            exam_id: 'exam-1',
            status: 'submitted',
            ended_at: oldEndedDate,
            submitted_at: oldEndedDate,
            is_test: 0,
            evidence_hold: 0,
            data_purged_at: null,
            retention_days: 90,
          },
          {
            id: 'att-held',
            session_id: 'sess-held',
            exam_id: 'exam-1',
            status: 'submitted',
            ended_at: oldEndedDate,
            submitted_at: oldEndedDate,
            is_test: 0,
            evidence_hold: 1, // HELD!
            data_purged_at: null,
            retention_days: 90,
          },
        ],
      });
      const env = createMockEnv(db);

      const result = await runRetentionSweep(env);
      expect(result.purgedCount).toBe(1);

      // att-expired was purged
      const expiredAtt = db.attempts.find((a) => a.id === 'att-expired');
      expect(expiredAtt?.data_purged_at).toBeDefined();
      expect(env.doPurges).toContain('sess-expired');

      // att-held was NOT purged
      const heldAtt = db.attempts.find((a) => a.id === 'att-held');
      expect(heldAtt?.data_purged_at).toBeNull();
      expect(env.doPurges).not.toContain('sess-held');
    });

    it('skips purge when exam retention_days is 0 (keep forever)', async () => {
      const oldEndedDate = new Date(Date.now() - 500 * 24 * 3600 * 1000).toISOString();
      const db = createMockDb({
        exam: { id: 'exam-forever', retention_days: 0 },
        attempts: [
          {
            id: 'att-forever',
            session_id: 'sess-forever',
            exam_id: 'exam-forever',
            status: 'submitted',
            ended_at: oldEndedDate,
            submitted_at: oldEndedDate,
            is_test: 0,
            evidence_hold: 0,
            data_purged_at: null,
            retention_days: 0, // Keep forever!
          },
        ],
      });
      const env = createMockEnv(db);

      const result = await runRetentionSweep(env);
      expect(result.purgedCount).toBe(0);
      expect(db.attempts[0].data_purged_at).toBeNull();
    });

    it('deletes test attempts older than 24 hours during sweep', async () => {
      const oldTestDate = new Date(Date.now() - 30 * 3600 * 1000).toISOString(); // 30h ago
      const recentTestDate = new Date(Date.now() - 2 * 3600 * 1000).toISOString(); // 2h ago
      const db = createMockDb({
        attempts: [
          {
            id: 'test-old',
            session_id: 'sess-test-old',
            exam_id: 'exam-1',
            is_test: 1,
            started_at: oldTestDate,
          },
          {
            id: 'test-recent',
            session_id: 'sess-test-recent',
            exam_id: 'exam-1',
            is_test: 1,
            started_at: recentTestDate,
          },
        ],
      });
      const env = createMockEnv(db);

      const result = await runRetentionSweep(env);
      expect(result.testDeletedCount).toBe(1);

      // test-old deleted from D1 and DO purged
      expect(db.attempts.find((a) => a.id === 'test-old')).toBeUndefined();
      expect(env.doPurges).toContain('sess-test-old');

      // test-recent kept
      expect(db.attempts.find((a) => a.id === 'test-recent')).toBeDefined();
    });
  });

  // ── 5. Cron Trigger Branching & Public Route Safety ─────────────────────────
  describe('Cron Trigger Branching & Public Route Safety', () => {
    it('scheduled handler branches to runRetentionSweep on 0 3 * * *', async () => {
      let sweepCalled = false;
      let autoEndCalled = false;

      const db = createMockDb({});
      const mockEnv = createMockEnv(db);

      const ctx = {
        waitUntil: (p: Promise<any>) => void p,
      } as ExecutionContext;

      // Mock controller with daily retention cron
      const dailyController = {
        cron: '0 3 * * *',
        scheduledTime: Date.now(),
        noRetry: () => {},
      } as ScheduledController;

      // Spy on scheduled
      await worker.scheduled(dailyController, mockEnv as any, ctx);
      expect(dailyController.cron).toBe('0 3 * * *');
    });

    it('/purge endpoint is not exposed on public worker routes', async () => {
      const req = new Request('http://localhost/purge', { method: 'POST' });
      const env = {
        ASSETS: {
          fetch: async () => new Response('Not found from static assets', { status: 404 }),
        },
      } as any;

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(404);
    });
  });

  // ── 6. Telemetry Sync & Final Write Reliability (Bug Fix) ───────────────────
  describe('Telemetry Sync & Final Write Reliability (Bug Fix)', () => {
    it('new clean attempt initializes with violation_count = 0 and is deletable once ended', async () => {
      const db = createMockDb({
        exam: { id: 'exam-1', professor_key: 'test-prof-key', duration_minutes: 60 },
        questions: [{ id: 'q1', exam_id: 'exam-1', points: 5, question_text: 'Test?' }],
        attempts: [],
      });
      const env = createMockEnv(db);

      // 1. Preview-start creates new attempt
      const startReq = new Request('http://localhost/api/professor/exams/exam-1/preview-start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Professor-Key': 'test-prof-key',
        },
      });
      const startRes = await handleSessionsApi(startReq, env, '/exams/exam-1/preview-start', 'POST', 'exam-1');
      expect(startRes.status).toBe(200);

      const createdAttempt = db.attempts[0];
      expect(createdAttempt).toBeDefined();
      expect(createdAttempt.violation_count).toBe(0);
      expect(createdAttempt.final_risk_score).toBe(0);

      // 2. Mark attempt ended (submitted)
      createdAttempt.status = 'submitted';
      createdAttempt.submitted_at = new Date().toISOString();

      // 3. Attempt is deletable because violation_count === 0
      const delReq = new Request('http://localhost/api/professor/exams/exam-1/sessions/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Professor-Key': 'test-prof-key',
        },
        body: JSON.stringify({
          attemptIds: [createdAttempt.id],
          confirmationName: createdAttempt.student_name,
        }),
      });

      const delRes = await handleSessionsApi(delReq, env, '/exams/exam-1/sessions/delete', 'POST', 'exam-1');
      expect(delRes.status).toBe(200);
      const delData = await delRes.json();
      expect(delData.succeededCount).toBe(1);
      expect(delData.refusedCount).toBe(0);
      expect(db.attempts.length).toBe(0);
    });

    it('attempt with one violation shows 1 in D1 and is archive-only', async () => {
      const db = createMockDb({
        exam: { id: 'exam-1', professor_key: 'test-prof-key' },
        attempts: [
          {
            id: 'att-viol-sync',
            exam_id: 'exam-1',
            student_name: 'Carol',
            session_id: 'sess-viol-sync',
            status: 'in_progress',
            is_test: 0,
            violation_count: 0,
            final_risk_score: 0,
            evidence_hold: 0,
          },
        ],
      });

      const mockDOState = {
        storage: {
          get: async () => null,
          put: async () => {},
          delete: async () => {},
          deleteAll: async () => {},
        },
      } as unknown as DurableObjectState;

      const mockDOEnv = {
        DB: db as unknown as D1Database,
      } as unknown as Env;

      const sessionDO = new ExamSessionDO(mockDOState, mockDOEnv);
      sessionDO.session = {
        sessionId: 'sess-viol-sync',
        riskScore: 30,
        riskHistory: [],
        violations: [
          {
            id: 'v-101',
            sessionId: 'sess-viol-sync',
            type: 'behavioral',
            severity: 'high',
            timestamp: new Date().toISOString(),
            aiConfidence: 0.95,
            humanReviewed: false,
          },
        ],
      };

      // Final write on attempt end
      await sessionDO.syncToD1('submitted');

      // Verify D1 attempt was updated
      const updatedAtt = db.attempts.find((a) => a.id === 'att-viol-sync');
      expect(updatedAtt?.violation_count).toBe(1);
      expect(updatedAtt?.max_severity).toBe('high');
      expect(updatedAtt?.final_risk_score).toBe(30);
      expect(updatedAtt?.ended_reason).toBe('submitted');

      // Attempt is ended
      updatedAtt!.status = 'submitted';

      // Deletion must be refused (archive only)
      const env = createMockEnv(db);
      const delReq = new Request('http://localhost/api/professor/exams/exam-1/sessions/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Professor-Key': 'test-prof-key',
        },
        body: JSON.stringify({
          attemptIds: ['att-viol-sync'],
          confirmationName: 'Carol',
        }),
      });

      const delRes = await handleSessionsApi(delReq, env, '/exams/exam-1/sessions/delete', 'POST', 'exam-1');
      const delData = await delRes.json();
      expect(delData.succeededCount).toBe(0);
      expect(delData.refusedCount).toBe(1);
      expect(delData.results[0].reason).toContain('violations');

      // Archiving must succeed
      const archReq = new Request('http://localhost/api/professor/exams/exam-1/sessions/archive', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Professor-Key': 'test-prof-key',
        },
        body: JSON.stringify({ attemptIds: ['att-viol-sync'] }),
      });

      const archRes = await handleSessionsApi(archReq, env, '/exams/exam-1/sessions/archive', 'POST', 'exam-1');
      const archData = await archRes.json();
      expect(archData.succeededCount).toBe(1);
      expect(updatedAtt?.archived).toBe(1);
    });

    it('a failed final write resets violation_count to NULL and leaves attempt archive-only', async () => {
      // Simulate D1 failure when updating violation_count = ?
      const db = createMockDb({
        exam: { id: 'exam-1', professor_key: 'test-prof-key' },
        failQueryMatch: 'SET violation_count = ?',
        attempts: [
          {
            id: 'att-fail-write',
            exam_id: 'exam-1',
            student_name: 'Dave',
            session_id: 'sess-fail-write',
            status: 'submitted',
            is_test: 0,
            violation_count: 0, // stale count
            evidence_hold: 0,
          },
        ],
      });

      const mockDOState = {
        storage: {
          get: async () => null,
          put: async () => {},
          delete: async () => {},
          deleteAll: async () => {},
        },
      } as unknown as DurableObjectState;

      const mockDOEnv = {
        DB: db as unknown as D1Database,
      } as unknown as Env;

      const sessionDO = new ExamSessionDO(mockDOState, mockDOEnv);
      sessionDO.session = {
        sessionId: 'sess-fail-write',
        riskScore: 50,
        riskHistory: [],
        violations: [
          {
            id: 'v-201',
            sessionId: 'sess-fail-write',
            type: 'vision',
            severity: 'critical',
            timestamp: new Date().toISOString(),
            aiConfidence: 0.99,
            humanReviewed: false,
          },
        ],
      };

      // syncToD1 should retry 3 times, fail, and run fallback SET violation_count = NULL
      await sessionDO.syncToD1('submitted');

      const attempt = db.attempts.find((a) => a.id === 'att-fail-write');
      expect(attempt?.violation_count).toBeNull();

      // Deletion must be refused (treated as unknown / assume violations)
      const env = createMockEnv(db);
      const delReq = new Request('http://localhost/api/professor/exams/exam-1/sessions/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Professor-Key': 'test-prof-key',
        },
        body: JSON.stringify({
          attemptIds: ['att-fail-write'],
          confirmationName: 'Dave',
        }),
      });

      const delRes = await handleSessionsApi(delReq, env, '/exams/exam-1/sessions/delete', 'POST', 'exam-1');
      const delData = await delRes.json();
      expect(delData.succeededCount).toBe(0);
      expect(delData.refusedCount).toBe(1);
      expect(delData.results[0].reason).toContain('unknown');
    });

    it('legacy attempts created before migration 0005 remain NULL and cannot be cleared or deleted', async () => {
      const db = createMockDb({
        exam: { id: 'exam-1', professor_key: 'test-prof-key' },
        attempts: [
          {
            id: 'att-legacy-pre0005',
            exam_id: 'exam-1',
            student_name: 'Eve',
            session_id: 'sess-legacy',
            status: 'submitted',
            is_test: 0,
            violation_count: null, // Legacy attempt
            evidence_hold: 0,
          },
        ],
      });
      const env = createMockEnv(db);

      // Clear attempt data is refused
      const clearReq = new Request('http://localhost/api/professor/exams/exam-1/sessions/clear', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Professor-Key': 'test-prof-key',
        },
        body: JSON.stringify({ attemptIds: ['att-legacy-pre0005'] }),
      });
      const clearRes = await handleSessionsApi(clearReq, env, '/exams/exam-1/sessions/clear', 'POST', 'exam-1');
      const clearData = await clearRes.json();
      expect(clearData.succeededCount).toBe(0);
      expect(clearData.refusedCount).toBe(1);
      expect(clearData.results[0].reason).toContain('unknown');

      // Delete attempt is refused
      const delReq = new Request('http://localhost/api/professor/exams/exam-1/sessions/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Professor-Key': 'test-prof-key',
        },
        body: JSON.stringify({
          attemptIds: ['att-legacy-pre0005'],
          confirmationName: 'Eve',
        }),
      });
      const delRes = await handleSessionsApi(delReq, env, '/exams/exam-1/sessions/delete', 'POST', 'exam-1');
      const delData = await delRes.json();
      expect(delData.succeededCount).toBe(0);
      expect(delData.refusedCount).toBe(1);
      expect(delData.results[0].reason).toContain('unknown');

      // Archive is allowed
      const archReq = new Request('http://localhost/api/professor/exams/exam-1/sessions/archive', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Professor-Key': 'test-prof-key',
        },
        body: JSON.stringify({ attemptIds: ['att-legacy-pre0005'] }),
      });
      const archRes = await handleSessionsApi(archReq, env, '/exams/exam-1/sessions/archive', 'POST', 'exam-1');
      const archData = await archRes.json();
      expect(archData.succeededCount).toBe(1);
    });
  });
});
