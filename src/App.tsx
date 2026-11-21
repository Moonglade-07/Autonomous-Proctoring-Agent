/**
 * App.tsx — root component.
 *
 * Routing (Phase 4c-1):
 *   /student              → StudentExamListPage (join exam by code, view my enrolled exams)
 *   /student/lobby/:examId→ StudentLobbyPage (system readiness checks, window countdown)
 *   /exam                 → ExamPage (student proctoring & exam-taking flow)
 *   /student/exam/:examId → ExamPage (student proctoring & exam-taking flow)
 *   /                     → ExamPage (legacy/direct proctoring)
 *
 *   /professor            → redirect to /professor/exams
 *   /professor/exams      → ExamListPage (list, create exam modal, duplicate, delete)
 *   /professor/exams/:id  → ExamEditorPage (Overview, Questions, Live Monitor, Submissions, Settings)
 *   /professor/exams/:id/live → ExamEditorPage (switches to Live Monitor tab)
 *
 * Auth is Phase 5 — PROFESSOR_KEY gate remains in place for professor area.
 */

import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ExamPage } from './pages/ExamPage';
import { ExamListPage } from './pages/ExamListPage';
import { ExamEditorPage } from './pages/ExamEditorPage';
import { ProfessorNav } from './components/ProfessorNav';
import { ProfessorKeyGate } from './components/ProfessorKeyGate';
import { getProfessorKey } from './hooks/useProfessorApi';
import { StudentExamListPage } from './pages/StudentExamListPage';
import { StudentLobbyPage } from './pages/StudentLobbyPage';
import { StudentResultPage } from './pages/StudentResultPage';
import { NotFoundPage } from './pages/NotFoundPage';

/** Wraps any professor-area page with key gating and the sticky top nav. */
function ProfessorLayout({ children }: { children: React.ReactNode }) {
  const [key, setKey] = useState<string>(() => getProfessorKey());

  if (!key) {
    return <ProfessorKeyGate onKeySet={(newKey) => setKey(newKey)} />;
  }

  return (
    <>
      <ProfessorNav onKeyChange={() => setKey('')} />
      {children}
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* ── Student exam flow (Phase 4c-1 & 4c-2a) ───────────────────────── */}
        <Route path="/student" element={<StudentExamListPage />} />
        <Route path="/student/lobby/:examId" element={<StudentLobbyPage />} />
        <Route path="/student/result/:examId" element={<StudentResultPage />} />
        <Route path="/student/exam/:examId" element={<ExamPage />} />
        <Route path="/exam" element={<ExamPage />} />
        <Route path="/" element={<ExamPage />} />

        {/* ── Professor area (Phase 4c-1: Exam-Centric) ───────────────────── */}
        {/* /professor redirects to /professor/exams */}
        <Route path="/professor" element={<Navigate to="/professor/exams" replace />} />

        <Route
          path="/professor/exams"
          element={
            <ProfessorLayout>
              <ExamListPage />
            </ProfessorLayout>
          }
        />
        <Route
          path="/professor/exams/new"
          element={
            <ProfessorLayout>
              <ExamEditorPage />
            </ProfessorLayout>
          }
        />
        <Route
          path="/professor/exams/:id"
          element={
            <ProfessorLayout>
              <ExamEditorPage />
            </ProfessorLayout>
          }
        />
        <Route
          path="/professor/exams/:id/live"
          element={
            <ProfessorLayout>
              <ExamEditorPage />
            </ProfessorLayout>
          }
        />

        {/* ── 404 Not Found ─────────────────────────────────────────────── */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}
