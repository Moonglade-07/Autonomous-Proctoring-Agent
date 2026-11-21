
/**
 * worker/utils/questionGrading.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 4c-2a: Unified Question Types, Zod Validation, and Grading Engine
 *
 * Types:
 *   - mcq: 2-6 options, exactly one correct, always auto
 *   - multi_select: 2-6 options, >=1 correct, always auto, exact set match
 *   - fill_in_blank: text with "___" blanks, accepted answers per blank, partial credit
 *   - short_answer: auto (accepted answers list, case-insensitive) or manual
 *   - long_answer: always manual, optional word limit
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { z } from 'zod';
import type { QuestionType, GradingMode, StudentQuestion } from '../types.js';

// ─── Blank Counter Helper ───────────────────────────────────────────────────

/**
 * Counts the number of triple-underscore (or more) markers in a question text.
 */
export function countBlanks(text: string): number {
  if (!text) return 0;
  const matches = text.match(/_{3,}/g);
  return matches ? matches.length : 0;
}

// ─── Question Validation Schemas ─────────────────────────────────────────────

const BaseQuestionSchema = z.object({
  question_text: z.string().trim().min(1, 'Question text cannot be empty'),
  points: z.number().positive('Points must be greater than 0'),
  topic: z.string().optional().default(''),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional().default('medium'),
  rubric: z.string().nullable().optional(),
});

export const MCQSchema = BaseQuestionSchema.extend({
  type: z.literal('mcq'),
  grading_mode: z.literal('auto').default('auto'),
  options: z
    .array(z.string().trim().min(1, 'Option cannot be empty'))
    .min(2, 'MCQ must have at least 2 options')
    .max(6, 'MCQ cannot have more than 6 options'),
  correct_answer: z.string().trim().min(1, 'Correct answer must be specified'),
}).refine(
  (data) => {
    if (data.options.includes(data.correct_answer)) return true;
    const idx = parseInt(data.correct_answer, 10);
    return !isNaN(idx) && idx >= 0 && idx < data.options.length;
  },
  {
    message: 'Correct answer must match one of the available options',
    path: ['correct_answer'],
  },
);

export const MultiSelectSchema = BaseQuestionSchema.extend({
  type: z.literal('multi_select'),
  grading_mode: z.literal('auto').default('auto'),
  options: z
    .array(z.string().trim().min(1, 'Option cannot be empty'))
    .min(2, 'Multi-select must have at least 2 options')
    .max(6, 'Multi-select cannot have more than 6 options'),
  correct_answer: z.string().min(1, 'At least one correct answer must be selected'),
}).refine(
  (data) => {
    try {
      let parsed = JSON.parse(data.correct_answer);
      if (!Array.isArray(parsed)) parsed = [parsed];
      if (parsed.length === 0) return false;
      return parsed.every((ans: unknown) => {
        if (typeof ans === 'string' && data.options.includes(ans)) return true;
        const idx = typeof ans === 'number' ? ans : parseInt(String(ans), 10);
        return !isNaN(idx) && idx >= 0 && idx < data.options.length;
      });
    } catch {
      return false;
    }
  },
  {
    message: 'Correct answers must be a non-empty array of valid options or indices',
    path: ['correct_answer'],
  },
);

export const FillInBlankSchema = BaseQuestionSchema.extend({
  type: z.literal('fill_in_blank'),
  grading_mode: z.literal('auto').default('auto'),
  options: z.array(z.string()).nullable().optional().default(null),
  correct_answer: z.string().min(1, 'Accepted answers configuration is required'),
}).superRefine((data, ctx) => {
  const blankCount = countBlanks(data.question_text);
  if (blankCount === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Question text must contain at least one "___" blank marker',
      path: ['question_text'],
    });
    return;
  }

  try {
    let parsed = JSON.parse(data.correct_answer);
    let blanksArray: string[][] = [];
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.blanks)) {
      blanksArray = parsed.blanks;
    } else if (Array.isArray(parsed)) {
      blanksArray = parsed;
    }

    if (blanksArray.length !== blankCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expected ${blankCount} blank configurations for ${blankCount} "___" markers, but received ${blanksArray.length}`,
        path: ['correct_answer'],
      });
      return;
    }

    for (let i = 0; i < blanksArray.length; i++) {
      const accepted = blanksArray[i];
      if (!Array.isArray(accepted) || accepted.filter((s) => typeof s === 'string' && s.trim().length > 0).length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Blank #${i + 1} must have at least one non-empty accepted answer`,
          path: ['correct_answer'],
        });
      }
    }
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'correct_answer must be valid JSON containing accepted answers per blank',
      path: ['correct_answer'],
    });
  }
});

export const ShortAnswerSchema = BaseQuestionSchema.extend({
  type: z.literal('short_answer'),
  grading_mode: z.enum(['auto', 'manual']),
  options: z.array(z.string()).nullable().optional().default(null),
  correct_answer: z.string().nullable().optional(),
}).superRefine((data, ctx) => {
  if (data.grading_mode === 'auto') {
    if (!data.correct_answer || data.correct_answer.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Auto-graded short answer questions must have at least one accepted answer',
        path: ['correct_answer'],
      });
      return;
    }

    try {
      const parsed = JSON.parse(data.correct_answer);
      if (Array.isArray(parsed)) {
        if (parsed.filter((s) => typeof s === 'string' && s.trim().length > 0).length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Accepted answers list cannot be empty',
            path: ['correct_answer'],
          });
        }
      }
    } catch {
      // Plain text answer is valid
    }
  }
});

export const LongAnswerSchema = BaseQuestionSchema.extend({
  type: z.literal('long_answer'),
  grading_mode: z.literal('manual').default('manual'),
  options: z.array(z.string()).nullable().optional().default(null),
  correct_answer: z.string().nullable().optional(),
});

export const QuestionCreateSchema = z.discriminatedUnion('type', [
  MCQSchema,
  MultiSelectSchema,
  FillInBlankSchema,
  ShortAnswerSchema,
  LongAnswerSchema,
]);

// ─── Answer-Leak Safe Student Question Allowlist ─────────────────────────────

/**
 * Transforms a database row into an answer-safe StudentQuestion object.
 * Strictly omits correct_answer, options (for non-choice types), and rubric.
 */
export function toStudentQuestion(raw: Record<string, unknown>): StudentQuestion {
  const type = (raw.type as QuestionType) || 'mcq';
  const text = (raw.question_text as string) || '';

  let parsedOptions: string[] | null = null;
  if (type === 'mcq' || type === 'multi_select') {
    if (Array.isArray(raw.options)) {
      parsedOptions = raw.options as string[];
    } else if (typeof raw.options === 'string' && raw.options.trim().length > 0) {
      try {
        parsedOptions = JSON.parse(raw.options) as string[];
      } catch {
        parsedOptions = null;
      }
    }
  }

  const blankCount = type === 'fill_in_blank' ? countBlanks(text) : undefined;

  let wordLimit: number | null | undefined = undefined;
  if (type === 'long_answer') {
    if (raw.correct_answer) {
      try {
        const parsed = JSON.parse(raw.correct_answer as string);
        if (parsed && typeof parsed.word_limit === 'number') {
          wordLimit = parsed.word_limit;
        }
      } catch {}
    }
    if (wordLimit === undefined && raw.options) {
      try {
        const opts = Array.isArray(raw.options)
          ? raw.options
          : typeof raw.options === 'string'
            ? JSON.parse(raw.options)
            : null;
        if (Array.isArray(opts) && opts[0]) {
          const parsedNum = parseInt(String(opts[0]), 10);
          if (!isNaN(parsedNum) && parsedNum > 0) {
            wordLimit = parsedNum;
          }
        }
      } catch {}
    }
  }

  return {
    id: raw.id as string,
    exam_id: raw.exam_id as string | undefined,
    type,
    question_text: text,
    options: parsedOptions,
    points: Number(raw.points) || 1,
    topic: (raw.topic as string) || '',
    difficulty: (raw.difficulty as 'easy' | 'medium' | 'hard') || 'medium',
    grading_mode: (raw.grading_mode as GradingMode) || (type === 'long_answer' ? 'manual' : 'auto'),
    ...(blankCount !== undefined ? { blank_count: blankCount } : {}),
    ...(wordLimit !== undefined ? { word_limit: wordLimit } : {}),
  };
}

// ─── Grading Engine ──────────────────────────────────────────────────────────

export interface QuestionForGrading {
  id: string;
  type: string;
  grading_mode?: string;
  correct_answer: string | null;
  points: number;
  question_text?: string;
  options?: string[] | null;
}

/** Per-answer grading breakdown */
export interface AnswerGradeResult {
  question_id: string;
  awarded_points: number | null;
  auto_points: number | null;
  grading_source: 'auto' | 'manual' | null;
}

export interface GradeResult {
  score: number;
  max_score: number;
  grading_status: 'auto_graded' | 'pending_manual';
  fully_graded: boolean;
  answer_grades: AnswerGradeResult[];
}

/**
 * Grades an attempt, computing auto points and per-answer breakdowns.
 *
 * Rules (Phase 4c-2a):
 * - Auto question: awarded_points = computed, auto_points = same, grading_source = 'auto'
 * - Manual question left blank: awarded_points = 0, auto_points = null, grading_source = 'manual' (auto-zero)
 * - Manual question with real answer: awarded_points = null, auto_points = null, grading_source = null (pending)
 * - attempts.score = SUM(awarded_points)
 * - fully_graded = true when no manual question has awarded_points === null
 */
export function gradeAttempt(
  questions: QuestionForGrading[],
  answers: Map<string, string>,
): GradeResult {
  let score = 0;
  let max_score = 0;
  let needsManual = false;
  const answer_grades: AnswerGradeResult[] = [];

  for (const q of questions) {
    const qPoints = Number(q.points) || 0;
    max_score += qPoints;

    const gradingMode =
      q.grading_mode ||
      (q.type === 'long_answer' || q.type === 'essay' || q.type === 'code' ? 'manual' : 'auto');

    const isManual =
      gradingMode === 'manual' ||
      q.type === 'long_answer' ||
      q.type === 'essay' ||
      q.type === 'code';

    const rawAnswer = answers.get(q.id);

    // Determine if student gave a real answer
    let hasRealAnswer = false;
    if (rawAnswer !== undefined && rawAnswer !== null && rawAnswer !== '""') {
      let parsed: unknown = rawAnswer;
      try {
        parsed = JSON.parse(rawAnswer);
      } catch {}

      if (typeof parsed === 'string') {
        hasRealAnswer = parsed.trim().length > 0;
      } else if (Array.isArray(parsed)) {
        hasRealAnswer = parsed.length > 0 && parsed.some((x) => String(x ?? '').trim().length > 0);
      } else if (parsed !== null && parsed !== undefined) {
        hasRealAnswer = String(parsed).trim().length > 0;
      }
    }

    if (isManual) {
      needsManual = true;
      if (hasRealAnswer) {
        answer_grades.push({
          question_id: q.id,
          awarded_points: null,
          auto_points: null,
          grading_source: null,
        });
      } else {
        // Auto-zero blank manual question so it never shows as pending
        answer_grades.push({
          question_id: q.id,
          awarded_points: 0,
          auto_points: null,
          grading_source: 'manual',
        });
      }
      continue;
    }

    // Auto questions
    if (!hasRealAnswer) {
      answer_grades.push({
        question_id: q.id,
        awarded_points: 0,
        auto_points: 0,
        grading_source: 'auto',
      });
      continue;
    }

    let studentAnswer: unknown;
    try {
      studentAnswer = JSON.parse(rawAnswer!);
    } catch {
      studentAnswer = rawAnswer;
    }

    let earned = 0;

    if (q.type === 'mcq' || q.type === 'true_false') {
      if (q.correct_answer) {
        const correctNorm = q.correct_answer.trim().toLowerCase();
        const studentNorm = String(studentAnswer).trim().toLowerCase();
        let isCorrect = correctNorm === studentNorm;
        if (!isCorrect && q.options) {
          const idx = parseInt(q.correct_answer, 10);
          if (!isNaN(idx) && idx >= 0 && idx < q.options.length) {
            isCorrect = q.options[idx].trim().toLowerCase() === studentNorm;
          }
        }
        if (isCorrect) {
          earned = qPoints;
        }
      }
    } else if (q.type === 'multi_select') {
      if (q.correct_answer) {
        try {
          let correctArray: unknown[] = JSON.parse(q.correct_answer);
          if (!Array.isArray(correctArray)) correctArray = [q.correct_answer];
          const studentArray = Array.isArray(studentAnswer)
            ? (studentAnswer as string[])
            : [String(studentAnswer)];

          const resolveOpt = (val: unknown): string => {
            const str = String(val).trim().toLowerCase();
            if (q.options) {
              const idx = typeof val === 'number' ? val : parseInt(String(val), 10);
              if (!isNaN(idx) && idx >= 0 && idx < q.options.length) {
                return q.options[idx].trim().toLowerCase();
              }
            }
            return str;
          };

          const correctSet = new Set(correctArray.map(resolveOpt));
          const studentSet = new Set(studentArray.map(resolveOpt));

          if (
            correctSet.size === studentSet.size &&
            [...correctSet].every((v) => studentSet.has(v))
          ) {
            earned = qPoints;
          }
        } catch {}
      }
    } else if (q.type === 'fill_in_blank') {
      if (q.correct_answer) {
        try {
          let parsedConfig = JSON.parse(q.correct_answer);
          let blanksList: string[][] = [];
          let caseInsensitive = true;

          if (
            parsedConfig &&
            typeof parsedConfig === 'object' &&
            Array.isArray(parsedConfig.blanks)
          ) {
            blanksList = parsedConfig.blanks;
            if (typeof parsedConfig.case_insensitive === 'boolean') {
              caseInsensitive = parsedConfig.case_insensitive;
            }
          } else if (Array.isArray(parsedConfig)) {
            blanksList = parsedConfig;
          }

          const numBlanks = blanksList.length;
          if (numBlanks > 0) {
            const studentBlanks = Array.isArray(studentAnswer) ? (studentAnswer as string[]) : [];
            const perBlankPoints = qPoints / numBlanks;

            for (let i = 0; i < numBlanks; i++) {
              const acceptedVariants = blanksList[i] || [];
              const studentVal = (studentBlanks[i] || '').trim();
              if (!studentVal) continue;

              const match = acceptedVariants.some((accepted) => {
                const accNorm = accepted.trim();
                if (caseInsensitive) {
                  return accNorm.toLowerCase() === studentVal.toLowerCase();
                }
                return accNorm === studentVal;
              });

              if (match) {
                earned += perBlankPoints;
              }
            }
          }
        } catch {}
      }
    } else if (q.type === 'short_answer') {
      if (q.correct_answer) {
        const studentNorm = String(studentAnswer).trim().toLowerCase();

        let acceptedList: string[] = [];
        try {
          const parsed = JSON.parse(q.correct_answer);
          if (Array.isArray(parsed)) {
            acceptedList = parsed.map((s) => String(s).trim().toLowerCase());
          } else {
            acceptedList = [String(q.correct_answer).trim().toLowerCase()];
          }
        } catch {
          acceptedList = [String(q.correct_answer).trim().toLowerCase()];
        }

        if (acceptedList.includes(studentNorm)) {
          earned = qPoints;
        }
      }
    }

    const roundedEarned = Math.round(earned * 100) / 100;
    score += roundedEarned;

    answer_grades.push({
      question_id: q.id,
      awarded_points: roundedEarned,
      auto_points: roundedEarned,
      grading_source: 'auto',
    });
  }

  // fully_graded = true when no manual answer is still pending review (null awarded_points)
  const fullyGraded = !answer_grades.some((ag) => ag.awarded_points === null);

  return {
    score: Math.round(score * 100) / 100,
    max_score: Math.round(max_score * 100) / 100,
    grading_status: needsManual ? 'pending_manual' : 'auto_graded',
    fully_graded: fullyGraded,
    answer_grades,
  };
}
