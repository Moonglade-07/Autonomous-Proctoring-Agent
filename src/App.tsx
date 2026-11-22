/**
 * App.tsx — root component (Phase 5a).
 *
 * Routing:
 *   /                     → HomePage (minimal landing page with Login & Signup links)
 *   /login                → LoginPage
 *   /signup               → SignupPage (students only)
 *
 *   /student              → StudentExamListPage (join exam by code, view my enrolled exams)
 *   /student/lobby/:examId→ StudentLobbyPage (system readiness checks, window countdown)
 *   /student/result/:examId→ StudentResultPage (scores, percentage, question review)
 *   /student/exam/:examId → ExamPage (student proctoring & exam-taking flow)
 *   /exam                 → ExamPage (student proctoring & exam-taking flow)
 *
 *   /professor            → redirect to /professor/exams
 *   /professor/exams      → ExamListPage (list, create exam modal, duplicate, delete)
 *   /professor/exams/new  → ExamEditorPage (create exam)
 *   /professor/exams/:id  → ExamEditorPage (Overview, Questions, Live Monitor, Submissions, Settings)
 *   /professor/exams/:id/live → ExamEditorPage (switches to Live Monitor tab)
 *
 *   *                     → NotFoundPage
 */

import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { LoginPage } from './pages/LoginPage';
import { SignupPage } from './pages/SignupPage';
import { HomePage } from './pages/HomePage';
import { ExamPage } from './pages/ExamPage';
import { ExamListPage } from './pages/ExamListPage';
import { ExamEditorPage } from './pages/ExamEditorPage';
import { ProfessorNav } from './components/ProfessorNav';
import { StudentExamListPage } from './pages/StudentExamListPage';
import { StudentLobbyPage } from './pages/StudentLobbyPage';
import { StudentResultPage } from './pages/StudentResultPage';
import { NotFoundPage } from './pages/NotFoundPage';

/** Wraps any professor-area page with the sticky top nav. */
function ProfessorLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ProfessorNav />
      {children}
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* ── Public Landing & Auth Pages ─────────────────────────────────── */}
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />

          {/* ── Student exam flow (Protected: Students only) ───────────────── */}
          <Route
            path="/student"
            element={
              <ProtectedRoute allowedRoles={['student']}>
                <StudentExamListPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/student/lobby/:examId"
            element={
              <ProtectedRoute allowedRoles={['student']}>
                <StudentLobbyPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/student/result/:examId"
            element={
              <ProtectedRoute allowedRoles={['student']}>
                <StudentResultPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/student/exam/:examId"
            element={
              <ProtectedRoute allowedRoles={['student', 'professor', 'admin']}>
                <ExamPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/exam"
            element={
              <ProtectedRoute allowedRoles={['student', 'professor', 'admin']}>
                <ExamPage />
              </ProtectedRoute>
            }
          />

          {/* ── Professor area (Protected: Professor or Admin) ─────────────── */}
          <Route path="/professor" element={<Navigate to="/professor/exams" replace />} />

          <Route
            path="/professor/exams"
            element={
              <ProtectedRoute allowedRoles={['professor', 'admin']}>
                <ProfessorLayout>
                  <ExamListPage />
                </ProfessorLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/professor/exams/new"
            element={
              <ProtectedRoute allowedRoles={['professor', 'admin']}>
                <ProfessorLayout>
                  <ExamEditorPage />
                </ProfessorLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/professor/exams/:id"
            element={
              <ProtectedRoute allowedRoles={['professor', 'admin']}>
                <ProfessorLayout>
                  <ExamEditorPage />
                </ProfessorLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/professor/exams/:id/live"
            element={
              <ProtectedRoute allowedRoles={['professor', 'admin']}>
                <ProfessorLayout>
                  <ExamEditorPage />
                </ProfessorLayout>
              </ProtectedRoute>
            }
          />

          {/* ── 404 Not Found ─────────────────────────────────────────────── */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
