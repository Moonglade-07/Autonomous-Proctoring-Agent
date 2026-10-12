/**
 * App.tsx — root component.
 *
 * Phase 3a routing:
 *   /professor  → ProfessorDashboard (live monitor, read-only)
 *   /           → ExamPage (student exam interface)
 *
 * Uses React Router v7 (BrowserRouter) for client-side routing.
 * Auth is Phase 5 — no login guards here.
 */

import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ExamPage } from './pages/ExamPage';
import { ProfessorDashboard } from './pages/ProfessorDashboard';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Student exam interface — default and /exam routes */}
        <Route path="/" element={<ExamPage />} />
        <Route path="/exam" element={<ExamPage />} />

        {/* Professor live monitor — read-only, no auth yet (Phase 5) */}
        <Route path="/professor" element={<ProfessorDashboard />} />

        {/* Fallback to exam page for any other path (SPA) */}
        <Route path="*" element={<ExamPage />} />
      </Routes>
    </BrowserRouter>
  );
}
