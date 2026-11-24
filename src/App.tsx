/**
 * App.tsx — root component (Phase 5c).
 *
 * Routing:
 *   /                     → HomePage (landing page with Login & Signup links, auto-redirect if logged in)
 *   /login                → LoginPage
 *   /signup               → SignupPage (students only)
 *
 *   /student              → StudentExamListPage (Student Home: Join, In Progress, Upcoming, Past exams)
 *   /student/system-check → StudentSystemCheckPage (Camera, Fullscreen, WebSockets, Latency diagnostics)
 *   /student/profile      → StudentProfilePage (Edit name, student ID, change password, privacy link)
 *   /student/help         → StudentHelpPage (FAQ & student troubleshooting)
 *   /student/privacy      → StudentPrivacyPage (Proctoring policy, retention, consent form)
 *   /student/lobby/:examId→ StudentLobbyPage (system readiness checks, window countdown)
 *   /student/result/:examId→ StudentResultPage (scores, percentage, question review)
 *   /student/exam/:examId → ExamPage (student proctoring & exam-taking flow)
 *   /exam                 → ExamPage (student proctoring & exam-taking flow)
 *
 *   /professor            → ProfessorHomePage (Professor Home: metrics, attention list, tabs, search/sort, archive)
 *   /professor/profile    → ProfessorProfilePage (Instructor profile & change password)
 *   /professor/exams      → ExamListPage (legacy full list)
 *   /professor/exams/new  → ExamEditorPage (create exam)
 *   /professor/exams/:id  → ExamEditorPage (Overview, Questions, Live Monitor, Submissions, Settings)
 *   /professor/exams/:id/live → ExamEditorPage (switches to Live Monitor tab)
 *
 *   *                     → NotFoundPage (404, role-aware, never shows /professor to student)
 */

import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { LoginPage } from './pages/LoginPage';
import { SignupPage } from './pages/SignupPage';
import { HomePage } from './pages/HomePage';
import { ExamPage } from './pages/ExamPage';
import { ExamListPage } from './pages/ExamListPage';
import { ExamEditorPage } from './pages/ExamEditorPage';
import { ProfessorNav } from './components/ProfessorNav';
import { ProfessorHomePage } from './pages/ProfessorHomePage';
import { ProfessorProfilePage } from './pages/ProfessorProfilePage';
import { StudentExamListPage } from './pages/StudentExamListPage';
import { StudentSystemCheckPage } from './pages/StudentSystemCheckPage';
import { StudentProfilePage } from './pages/StudentProfilePage';
import { StudentHelpPage } from './pages/StudentHelpPage';
import { StudentPrivacyPage } from './pages/StudentPrivacyPage';
import { StudentLobbyPage } from './pages/StudentLobbyPage';
import { StudentResultPage } from './pages/StudentResultPage';
import { ProfessorReviewQueuePage } from './pages/ProfessorReviewQueuePage';
import { ProfessorReportPage } from './pages/ProfessorReportPage';
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

          {/* ── Student Portal & Exam Flow (Protected: Students only) ───────── */}
          <Route
            path="/student"
            element={
              <ProtectedRoute allowedRoles={['student']}>
                <StudentExamListPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/student/system-check"
            element={
              <ProtectedRoute allowedRoles={['student']}>
                <StudentSystemCheckPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/student/profile"
            element={
              <ProtectedRoute allowedRoles={['student']}>
                <StudentProfilePage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/student/help"
            element={
              <ProtectedRoute allowedRoles={['student']}>
                <StudentHelpPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/student/privacy"
            element={
              <ProtectedRoute allowedRoles={['student']}>
                <StudentPrivacyPage />
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
          <Route
            path="/professor"
            element={
              <ProtectedRoute allowedRoles={['professor', 'admin']}>
                <ProfessorLayout>
                  <ProfessorHomePage />
                </ProfessorLayout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/professor/profile"
            element={
              <ProtectedRoute allowedRoles={['professor', 'admin']}>
                <ProfessorLayout>
                  <ProfessorProfilePage />
                </ProfessorLayout>
              </ProtectedRoute>
            }
          />
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
          <Route
            path="/professor/review"
            element={
              <ProtectedRoute allowedRoles={['professor', 'admin']}>
                <ProfessorReviewQueuePage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/professor/attempts/:attemptId/report"
            element={
              <ProtectedRoute allowedRoles={['professor', 'admin']}>
                <ProfessorReportPage />
              </ProtectedRoute>
            }
          />

          {/* ── Catch-All 404 Page ─────────────────────────────────────────── */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
