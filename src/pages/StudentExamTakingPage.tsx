/**
 * StudentExamTakingPage.tsx
 * ─────────────────────────────────────────────────────────────────
 * Re-exports ExamPage to guarantee that all student exam-taking
 * flows run through the unified, fully proctored ExamPage with
 * identity capture, webcam feed, face detection, behavioral monitoring,
 * and professor intervention controls.
 * ─────────────────────────────────────────────────────────────────
 */

export { ExamPage as StudentExamTakingPage } from './ExamPage';
export { ExamPage as default } from './ExamPage';
