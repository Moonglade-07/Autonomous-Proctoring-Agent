/**
 * answer-leak.test.ts — Phase 4b answer-leak protection tests
 *
 * Asserts that no student-facing API response contains correct_answer,
 * correctAnswer, or correct_answer_json in any form.
 *
 * Run: npx vitest run
 */

import { describe, it, expect } from 'vitest';

// ─── toStudentQuestion allowlist (mirrors worker/api/student.ts) ─────────────

type RawQuestion = {
  id: string;
  type: string;
  question_text: string;
  options: string | null;
  correct_answer: string | null;
  correct_answer_json?: string | null;
  points: number;
  topic: string;
  difficulty: string;
};

type StudentQuestion = {
  id: string;
  type: string;
  question_text: string;
  options: string[] | null;
  points: number;
  topic: string;
  difficulty: string;
};

function toStudentQuestion(raw: RawQuestion | Record<string, unknown>): StudentQuestion {
  let parsedOptions: string[] | null = null;
  if (Array.isArray(raw.options)) {
    parsedOptions = raw.options as string[];
  } else if (typeof raw.options === 'string' && raw.options.trim().length > 0) {
    try {
      parsedOptions = JSON.parse(raw.options) as string[];
    } catch {
      parsedOptions = null;
    }
  }

  return {
    id: raw.id as string,
    type: raw.type as string,
    question_text: raw.question_text as string,
    options: parsedOptions,
    points: raw.points as number,
    topic: (raw.topic as string) ?? '',
    difficulty: (raw.difficulty as string) ?? 'medium',
  };
}

// ─── Leak detector ───────────────────────────────────────────────────────────

function containsAnswerLeak(value: unknown): boolean {
  const serialized = JSON.stringify(value) ?? '';
  return (
    serialized.includes('correct_answer') ||
    serialized.includes('correctAnswer') ||
    serialized.includes('correct_answer_json')
  );
}

// ─── Test fixtures ───────────────────────────────────────────────────────────

const fixtures: RawQuestion[] = [
  {
    id: 'q-001',
    type: 'mcq',
    question_text: 'What is O(log n) sort?',
    options: '["Bubble","Merge","Insertion","Quick"]',
    correct_answer: 'Merge',
    correct_answer_json: '["Merge"]',
    points: 2,
    topic: 'Algorithms',
    difficulty: 'easy',
  },
  {
    id: 'q-002',
    type: 'multi_select',
    question_text: 'Which are O(1) operations?',
    options: '["Array index","Hash lookup","Binary search","Linked list tail"]',
    correct_answer: '["Array index","Hash lookup"]',
    points: 3,
    topic: 'Data Structures',
    difficulty: 'medium',
  },
  {
    id: 'q-003',
    type: 'short_answer',
    question_text: 'Define Big-O notation.',
    options: null,
    correct_answer: 'Big-O describes the worst-case asymptotic growth of an algorithm.',
    points: 5,
    topic: 'Algorithms',
    difficulty: 'hard',
  },
  {
    id: 'q-004',
    type: 'essay',
    question_text: 'Compare DFS and BFS.',
    options: null,
    correct_answer: null,
    points: 10,
    topic: 'Algorithms',
    difficulty: 'hard',
  },
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('toStudentQuestion — answer-leak protection', () => {
  it('maps every fixture without leaking correct_answer', () => {
    const studentQuestions = fixtures.map(toStudentQuestion);
    expect(containsAnswerLeak(studentQuestions)).toBe(false);
  });

  it('returns exactly the allowed fields for an MCQ question', () => {
    const sq = toStudentQuestion(fixtures[0]);
    const keys = Object.keys(sq).sort();
    expect(keys).toEqual(
      ['difficulty', 'id', 'options', 'points', 'question_text', 'topic', 'type'].sort(),
    );
  });

  it('parses options JSON into an array', () => {
    const sq = toStudentQuestion(fixtures[0]);
    expect(Array.isArray(sq.options)).toBe(true);
    expect(sq.options).toHaveLength(4);
  });

  it('returns null options for short_answer and essay questions', () => {
    const sq3 = toStudentQuestion(fixtures[2]);
    const sq4 = toStudentQuestion(fixtures[3]);
    expect(sq3.options).toBeNull();
    expect(sq4.options).toBeNull();
  });

  it('does not include correct_answer in the returned object', () => {
    for (const fixture of fixtures) {
      const sq = toStudentQuestion(fixture);
      expect(sq).not.toHaveProperty('correct_answer');
      expect(sq).not.toHaveProperty('correctAnswer');
      expect(sq).not.toHaveProperty('correct_answer_json');
    }
  });

  it('containsAnswerLeak correctly detects a leak', () => {
    const leakyData = { id: 'q-1', correct_answer: 'secret' };
    expect(containsAnswerLeak(leakyData)).toBe(true);
  });

  it('containsAnswerLeak correctly detects a camelCase leak', () => {
    const leakyData = { id: 'q-1', correctAnswer: 'secret' };
    expect(containsAnswerLeak(leakyData)).toBe(true);
  });

  it('containsAnswerLeak is false for clean student questions', () => {
    const clean = fixtures.map(toStudentQuestion);
    expect(containsAnswerLeak(clean)).toBe(false);
  });

  it('handles options that are already arrays from parsed snapshot_json without throwing', () => {
    const raw = {
      id: 'q-snap',
      type: 'mcq',
      question_text: 'Sample',
      options: ['Option A', 'Option B'],
      correct_answer: 'Option A',
      points: 2,
      topic: 'Test',
      difficulty: 'easy',
    };
    const studentQ = toStudentQuestion(raw);
    expect(studentQ.options).toEqual(['Option A', 'Option B']);
    expect(containsAnswerLeak(studentQ)).toBe(false);
  });
});

describe('Simulated /api/student/exams/:id response', () => {
  it('exam + questions object has no answer leak', () => {
    const response = {
      exam: {
        id: 'exam-1',
        title: 'CS101 Midterm',
        duration_minutes: 90,
        status: 'active',
        show_answers: 0,
      },
      questions: fixtures.map(toStudentQuestion),
    };
    expect(containsAnswerLeak(response)).toBe(false);
  });
});

describe('Simulated /api/student/attempts/:id/result (show_answers=0)', () => {
  it('result without reveal has no answer leak', () => {
    const result = {
      attempt: {
        id: 'at-abc123',
        exam_id: 'exam-1',
        student_name: 'Alice',
        status: 'submitted',
        score: 7,
        max_score: 11,
        grading_status: 'auto_graded',
      },
      answers: [
        { question_id: 'q-001', answer_json: '"Merge"' },
        { question_id: 'q-002', answer_json: '["Array index","Hash lookup"]' },
      ],
    };
    expect(containsAnswerLeak(result)).toBe(false);
  });

  it('strictly excludes Phase 6 integrity reports, violations, risk scores, and review decisions', () => {
    const prohibitedKeys = [
      'review_decision',
      'reviewDecision',
      'review_note',
      'reviewNote',
      'reviewed_at',
      'reviewedAt',
      'reviewed_by',
      'reviewedBy',
      'final_risk_score',
      'finalRiskScore',
      'riskScore',
      'violation_count',
      'violationCount',
      'max_severity',
      'maxSeverity',
      'violations',
      'riskTimeline',
      'reviewLevel',
      'report',
    ];

    const studentResult = {
      attempt: {
        id: 'at-abc123',
        exam_id: 'exam-1',
        student_name: 'Alice',
        status: 'submitted',
        score: 7,
        max_score: 11,
        grading_status: 'auto_graded',
      },
      answers: [
        { question_id: 'q-001', answer_json: '"Merge"' },
      ],
    };

    const serialized = JSON.stringify(studentResult);
    for (const key of prohibitedKeys) {
      expect(serialized).not.toContain(`"${key}"`);
      expect(key in (studentResult.attempt as any)).toBe(false);
    }
  });
});
