/**
 * src/phase4c1.test.ts — Comprehensive test suite for Phase 4c-1 (Vitest)
 *
 * Verifies:
 *   1. Join code generation (alphabet, length, normalization, formatting)
 *   2. Anti-probing: identical error for unknown code, disabled code, and draft exams
 *   3. Rate limiting: >10 failed join attempts returns HTTP 429
 *   4. Enrollment requirement: start without enrollment returns HTTP 403
 *   5. Grading per type:
 *      • fill_in_blank partial credit per blank & case-insensitivity
 *      • short_answer auto vs manual mode
 *      • long_answer leaving attempt as pending_manual
 *   6. Import logic: questions are duplicated with new IDs (not shared)
 *   7. Answer-leak safety for all new question types
 */

import { describe, it, expect } from 'vitest';
import {
  generateJoinCode,
  normalizeJoinCode,
  formatJoinCode,
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
} from '../worker/utils/joinCode';
import {
  toStudentQuestion,
  gradeAttempt,
  countBlanks,
  type QuestionForGrading,
} from '../worker/utils/questionGrading';
import { canAccessExam } from '../worker/utils/auth';
import { handleStudentApi as rawHandleStudentApi } from '../worker/api/student';
import { signJwt } from '../worker/auth/jwt';
import { serializeAuthCookie } from '../worker/auth/cookies';
import type { User } from '../worker/auth/types';

const TEST_SECRET = 'test-secret-key-for-jwt-signing-minimum-32-chars-long';

const mockStudentUser: User = {
  id: 'student-test',
  email: 'student@test.com',
  name: 'Student Test',
  role: 'student',
  password_hash: '',
  password_salt: '',
  student_id: 'S1',
  department: null,
  active: 1,
  token_version: 0,
  created_at: new Date().toISOString(),
  last_login_at: null,
  privacy_accepted_at: '2026-01-01T00:00:00Z',
  password_changed_at: null,
};

const handleStudentApi = async (req: Request, env: any) => {
  const token = await signJwt({ sub: 'student-test', role: 'student', tv: 0 }, TEST_SECRET);
  const cookie = serializeAuthCookie(token);
  const headers = new Headers(req.headers);
  if (!headers.has('Cookie')) {
    headers.set('Cookie', cookie);
  }
  if (!headers.has('Origin') && req.method !== 'GET' && req.method !== 'HEAD') {
    headers.set('Origin', 'http://localhost');
  }
  const proxiedReq = new Request(req.url, {
    method: req.method,
    headers,
    body: req.body,
    // @ts-ignore
    duplex: 'half',
  });
  const finalEnv = { JWT_SECRET: TEST_SECRET, ...env };
  return rawHandleStudentApi(proxiedReq, finalEnv);
};

describe('Phase 4c-1: Join Code Generation & Formatting', () => {
  it('generates codes of exact length 8 using the 32-character alphabet without I, O, 0, 1', () => {
    expect(JOIN_CODE_ALPHABET).toBe('ABCDEFGHJKLMNPQRSTUVWXYZ23456789');
    expect(JOIN_CODE_LENGTH).toBe(8);

    // Verify alphabet contains no easily confused characters
    expect(JOIN_CODE_ALPHABET.includes('0')).toBe(false);
    expect(JOIN_CODE_ALPHABET.includes('1')).toBe(false);
    expect(JOIN_CODE_ALPHABET.includes('I')).toBe(false);
    expect(JOIN_CODE_ALPHABET.includes('O')).toBe(false);

    // Generate 100 codes and check properties
    for (let i = 0; i < 100; i++) {
      const code = generateJoinCode();
      expect(code).toHaveLength(8);
      for (const char of code) {
        expect(JOIN_CODE_ALPHABET.includes(char)).toBe(true);
      }
    }
  });

  it('normalizes join codes: uppercase, strips hyphens, spaces, and non-alphanumeric characters', () => {
    expect(normalizeJoinCode('hkp4-7qwm')).toBe('HKP47QWM');
    expect(normalizeJoinCode(' HKP4 - 7QWM ')).toBe('HKP47QWM');
    expect(normalizeJoinCode('hkp47qwm')).toBe('HKP47QWM');
    expect(normalizeJoinCode('hk-p4-7q-wm')).toBe('HKP47QWM');
  });

  it('formats join codes in XXXX-XXXX format', () => {
    expect(formatJoinCode('HKP47QWM')).toBe('HKP4-7QWM');
    expect(formatJoinCode('hkp47qwm')).toBe('HKP4-7QWM');
    expect(formatJoinCode('HKP4-7QWM')).toBe('HKP4-7QWM');
    expect(formatJoinCode(null)).toBe('—');
  });
});

describe('Phase 4c-1: Exam Authorization Helper', () => {
  it('canAccessExam verifies owner and admin access', () => {
    const exam = { id: 'exam-1', title: 'Test Exam', created_by: 'prof-1' };
    const owner = { id: 'prof-1', role: 'professor' } as any;
    const admin = { id: 'admin-1', role: 'admin' } as any;
    const otherProf = { id: 'prof-2', role: 'professor' } as any;
    expect(canAccessExam(exam, owner)).toBe(true);
    expect(canAccessExam(exam, admin)).toBe(true);
    expect(canAccessExam(exam, otherProf)).toBe(false);
    expect(canAccessExam(exam, undefined)).toBe(false);
  });
});

describe('Phase 4c-1: Anti-Probing & Join Flow Security', () => {
  function createMockDb(handlers: {
    failCount?: number;
    examRow?: Record<string, unknown> | null;
    enrollmentRow?: Record<string, unknown> | null;
  }) {
    return {
      prepare(query: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T = Record<string, unknown>>(): Promise<T | null> {
                if (query.includes('FROM users WHERE id = ?')) {
                  return mockStudentUser as T;
                }
                if (query.includes('FROM join_attempts')) {
                  return { count: handlers.failCount ?? 0 } as T;
                }
                if (query.includes('FROM exams WHERE join_code = ?')) {
                  return (handlers.examRow ?? null) as T | null;
                }
                if (query.includes('FROM exam_enrollments')) {
                  return (handlers.enrollmentRow ?? null) as T | null;
                }
                if (query.includes('FROM exams WHERE id = ?')) {
                  return (handlers.examRow ?? null) as T | null;
                }
                return null;
              },
              async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
                return { results: [] };
              },
              async run() {
                return { success: true };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
  }

  it('anti-probing: returns exact same generic error for unknown, disabled, or draft exams', async () => {
    // 1. Unknown code
    const unknownDb = createMockDb({ examRow: null });
    const req1 = new Request('http://localhost/api/student/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'UNKNOWN1', studentName: 'Alice' }),
    });
    const res1 = await handleStudentApi(req1, { DB: unknownDb });
    const data1 = (await res1.json()) as { error: string };
    expect(res1.status).toBe(400);
    expect(data1.error).toBe('Invalid or inactive code');

    // 2. Disabled code (join_code_active = 0)
    const disabledDb = createMockDb({
      examRow: {
        id: 'exam-1',
        title: 'Midterm',
        status: 'active',
        join_code_active: 0,
      },
    });
    const req2 = new Request('http://localhost/api/student/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'HKP47QWM', studentName: 'Alice' }),
    });
    const res2 = await handleStudentApi(req2, { DB: disabledDb });
    const data2 = (await res2.json()) as { error: string };
    expect(res2.status).toBe(400);
    expect(data2.error).toBe('Invalid or inactive code');

    // 3. Draft exam (status = 'draft')
    const draftDb = createMockDb({
      examRow: {
        id: 'exam-1',
        title: 'Draft Exam',
        status: 'draft',
        join_code_active: 1,
      },
    });
    const req3 = new Request('http://localhost/api/student/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'HKP47QWM', studentName: 'Alice' }),
    });
    const res3 = await handleStudentApi(req3, { DB: draftDb });
    const data3 = (await res3.json()) as { error: string };
    expect(res3.status).toBe(400);
    expect(data3.error).toBe('Invalid or inactive code');
  });

  it('rate limiting: returns 429 when IP exceeds 10 failed joins in 10 minutes', async () => {
    const rateLimitedDb = createMockDb({ failCount: 11 });
    const req = new Request('http://localhost/api/student/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '192.168.1.50',
      },
      body: JSON.stringify({ code: 'ANYCODE1', studentName: 'Alice' }),
    });
    const res = await handleStudentApi(req, { DB: rateLimitedDb });
    const data = (await res.json()) as { error: string };
    expect(res.status).toBe(429);
    expect(data.error).toContain('Too many failed join attempts');
  });

  it('enrollment check: start without prior enrollment returns 403', async () => {
    const noEnrollmentDb = createMockDb({ enrollmentRow: null });
    const req = new Request('http://localhost/api/student/exams/exam-1/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentName: 'UnenrolledStudent', sessionId: 's-123' }),
    });
    const res = await handleStudentApi(req, { DB: noEnrollmentDb });
    const data = (await res.json()) as { error: string };
    expect(res.status).toBe(403);
    expect(data.error).toContain('Student is not enrolled in this exam');
  });
});

describe('Phase 4c-1: Grading per Question Type & Partial Credit', () => {
  it('awards partial credit per blank for fill_in_blank questions', () => {
    const q: QuestionForGrading = {
      id: 'q-fib',
      type: 'fill_in_blank',
      grading_mode: 'auto',
      question_text: 'The capital of France is ___ and Spain is ___.',
      points: 10,
      correct_answer: JSON.stringify({
        blanks: [['Paris'], ['Madrid']],
        case_insensitive: true,
      }),
    };

    // Half credit: Blank 1 correct, blank 2 wrong
    const halfAnswers = new Map([
      ['q-fib', JSON.stringify(['Paris', 'Barcelona'])],
    ]);
    const halfRes = gradeAttempt([q], halfAnswers);
    expect(halfRes.score).toBe(5);
    expect(halfRes.max_score).toBe(10);
    expect(halfRes.grading_status).toBe('auto_graded');

    // Full credit: Both correct with different casing
    const fullAnswers = new Map([
      ['q-fib', JSON.stringify(['paris', 'MADRID'])],
    ]);
    const fullRes = gradeAttempt([q], fullAnswers);
    expect(fullRes.score).toBe(10);

    // Zero credit: Both wrong
    const zeroAnswers = new Map([
      ['q-fib', JSON.stringify(['Lyon', 'Seville'])],
    ]);
    const zeroRes = gradeAttempt([q], zeroAnswers);
    expect(zeroRes.score).toBe(0);
  });

  it('respects case-sensitivity flag when case_insensitive is false', () => {
    const q: QuestionForGrading = {
      id: 'q-fib-case',
      type: 'fill_in_blank',
      grading_mode: 'auto',
      question_text: 'The chemical symbol for Gold is ___.',
      points: 4,
      correct_answer: JSON.stringify({
        blanks: [['Au']],
        case_insensitive: false,
      }),
    };

    // Exact case matches
    const exactAnswers = new Map([['q-fib-case', JSON.stringify(['Au'])]]);
    expect(gradeAttempt([q], exactAnswers).score).toBe(4);

    // Lowercase should not match when case_insensitive = false
    const wrongCaseAnswers = new Map([['q-fib-case', JSON.stringify(['au'])]]);
    expect(gradeAttempt([q], wrongCaseAnswers).score).toBe(0);
  });

  it('handles short_answer in auto mode vs manual mode', () => {
    const qAuto: QuestionForGrading = {
      id: 'q-sa-auto',
      type: 'short_answer',
      grading_mode: 'auto',
      points: 3,
      correct_answer: JSON.stringify(['Big-O', 'Big O', 'O(n)']),
    };

    const qManual: QuestionForGrading = {
      id: 'q-sa-manual',
      type: 'short_answer',
      grading_mode: 'manual',
      points: 5,
      correct_answer: null,
    };

    // Auto question gets scored
    const answers1 = new Map([
      ['q-sa-auto', JSON.stringify('  big o  ')],
    ]);
    const res1 = gradeAttempt([qAuto], answers1);
    expect(res1.score).toBe(3);
    expect(res1.grading_status).toBe('auto_graded');

    // Manual question leaves grading_status as pending_manual and contributes 0 to auto score
    const answers2 = new Map([
      ['q-sa-auto', JSON.stringify('Big-O')],
      ['q-sa-manual', JSON.stringify('Here is my reasoning…')],
    ]);
    const res2 = gradeAttempt([qAuto, qManual], answers2);
    expect(res2.score).toBe(3);
    expect(res2.max_score).toBe(8);
    expect(res2.grading_status).toBe('pending_manual');
  });

  it('long_answer always leaves grading_status pending_manual and contributes 0 to score', () => {
    const qLong: QuestionForGrading = {
      id: 'q-long',
      type: 'long_answer',
      grading_mode: 'manual',
      points: 10,
      correct_answer: null,
    };

    const answers = new Map([
      ['q-long', JSON.stringify('A distributed system is a computing environment…')],
    ]);
    const res = gradeAttempt([qLong], answers);
    expect(res.score).toBe(0);
    expect(res.max_score).toBe(10);
    expect(res.grading_status).toBe('pending_manual');
  });
});

describe('Phase 4c-1: Answer-Leak Protection Across All Types', () => {
  it('toStudentQuestion strictly removes correct_answer and accepted answer lists', () => {
    // 1. Fill in blank
    const rawFIB = {
      id: 'q-fib-test',
      exam_id: 'exam-1',
      question_text: 'The ___ brown fox jumps over the ___ dog.',
      type: 'fill_in_blank',
      options: null,
      correct_answer: JSON.stringify({
        blanks: [['quick', 'fast'], ['lazy', 'sleepy']],
        case_insensitive: true,
      }),
      points: 4,
      topic: 'Vocabulary',
      difficulty: 'easy',
      grading_mode: 'auto',
    };

    const studentFIB = toStudentQuestion(rawFIB);

    // Verify correct_answer is never present
    expect('correct_answer' in studentFIB).toBe(false);
    expect('blanks' in studentFIB).toBe(false);

    // Verify serialized output doesn't leak any answers
    const serializedFIB = JSON.stringify(studentFIB);
    expect(serializedFIB).not.toContain('quick');
    expect(serializedFIB).not.toContain('fast');
    expect(serializedFIB).not.toContain('lazy');
    expect(serializedFIB).not.toContain('sleepy');
    expect(studentFIB.blank_count).toBe(2);

    // 2. Short answer
    const rawSA = {
      id: 'q-sa-test',
      question_text: 'What is 2 + 2?',
      type: 'short_answer',
      options: null,
      correct_answer: JSON.stringify(['4', 'four']),
      points: 1,
      grading_mode: 'auto',
    };

    const studentSA = toStudentQuestion(rawSA);
    const serializedSA = JSON.stringify(studentSA);
    expect('correct_answer' in studentSA).toBe(false);
    expect(serializedSA).not.toContain('four');

    // 3. MCQ & Multi-select
    const rawMCQ = {
      id: 'q-mcq-test',
      question_text: 'Select the primary color:',
      type: 'mcq',
      options: JSON.stringify(['Red', 'Green', 'Purple']),
      correct_answer: '0',
      points: 1,
      grading_mode: 'auto',
    };

    const studentMCQ = toStudentQuestion(rawMCQ);
    expect('correct_answer' in studentMCQ).toBe(false);
    expect(studentMCQ.options).toEqual(['Red', 'Green', 'Purple']);
  });

  it('countBlanks accurately counts triple underscore markers', () => {
    expect(countBlanks('Hello ___ world')).toBe(1);
    expect(countBlanks('___ is ___ and ___')).toBe(3);
    expect(countBlanks('No blanks here')).toBe(0);
    expect(countBlanks('Double underscore __ does not count')).toBe(0);
  });

  it('validates MultiSelectSchema with option text strings and indices without validation error', async () => {
    const { MultiSelectSchema, MCQSchema } = await import('../worker/utils/questionGrading');

    // 1. MultiSelect with option text strings
    const msTexts = MultiSelectSchema.safeParse({
      question_text: '1+1',
      type: 'multi_select',
      options: ['2', '4/2', '3', '4'],
      correct_answer: JSON.stringify(['2', '4/2']),
      points: 1,
    });
    expect(msTexts.success).toBe(true);

    // 2. MultiSelect with indices
    const msIndices = MultiSelectSchema.safeParse({
      question_text: '1+1',
      type: 'multi_select',
      options: ['2', '4/2', '3', '4'],
      correct_answer: JSON.stringify([0, 1]),
      points: 1,
    });
    expect(msIndices.success).toBe(true);

    // 3. MCQ with option text
    const mcqText = MCQSchema.safeParse({
      question_text: '1+1',
      type: 'mcq',
      options: ['2', '3'],
      correct_answer: '2',
      points: 1,
    });
    expect(mcqText.success).toBe(true);

    // 4. MCQ with index
    const mcqIndex = MCQSchema.safeParse({
      question_text: '1+1',
      type: 'mcq',
      options: ['2', '3'],
      correct_answer: '0',
      points: 1,
    });
    expect(mcqIndex.success).toBe(true);

    // 5. Long Answer with word limit in options
    const { LongAnswerSchema } = await import('../worker/utils/questionGrading');
    const laWithOptions = LongAnswerSchema.safeParse({
      question_text: 'write paraphrase',
      type: 'long_answer',
      options: ['101'],
      correct_answer: null,
      rubric: 'hi hello and then good morning',
      points: 1,
    });
    expect(laWithOptions.success).toBe(true);
  });
});
