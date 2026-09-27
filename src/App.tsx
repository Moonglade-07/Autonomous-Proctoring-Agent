import { ExamPage } from './pages/ExamPage';

/**
 * App.tsx — root component.
 * Phase 1 only has the /exam route, so we render ExamPage directly.
 * A router (e.g. React Router) will be added in a future phase.
 */
export default function App() {
  return <ExamPage />;
}
