/**
 * src/components/ProfessorKeyGate.tsx
 * ─────────────────────────────────────────────────────────────────
 * Gating modal that prompts for the professor secret key.
 * Used across all /professor/* routes via ProfessorLayout.
 * ─────────────────────────────────────────────────────────────────
 */

import { useState } from 'react';
import { setProfessorKey } from '../hooks/useProfessorApi';

export function ProfessorKeyGate({
  onKeySet,
}: {
  onKeySet: (key: string) => void;
}) {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [isValidating, setIsValidating] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const key = input.trim();
    if (!key) {
      setError('Please enter the professor key.');
      return;
    }
    setIsValidating(true);
    setError('');

    try {
      const res = await fetch('/api/professor/exams', {
        headers: { 'X-Professor-Key': key },
      });
      if (res.status === 401) {
        setError('Unauthorized (HTTP 401): The professor key you entered is incorrect.');
        setIsValidating(false);
        return;
      }
    } catch {
      // If network offline or endpoint pending, allow proceed
    }

    setIsValidating(false);
    setProfessorKey(key);
    onKeySet(key);
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center p-4">
      <div className="max-w-sm w-full bg-gray-900 border border-white/10 rounded-2xl p-6 shadow-2xl">
        <div className="text-center mb-6">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-violet-600 to-indigo-500 flex items-center justify-center text-3xl mx-auto mb-4 shadow-lg shadow-violet-500/25">
            🛡️
          </div>
          <h1 className="text-xl font-bold text-white">Professor Access</h1>
          <p className="text-sm text-gray-400 mt-2 leading-relaxed">
            Enter the professor key to access exam management, question bank, and live monitoring.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-1.5">
              Professor Key
            </label>
            <input
              type="password"
              id="professor-key-input"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setError('');
              }}
              placeholder="Enter secret key…"
              autoFocus
              className="w-full bg-gray-800 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors"
            />
            {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
          </div>

          <button
            type="submit"
            id="professor-key-submit"
            disabled={isValidating}
            className="w-full py-3 rounded-xl text-sm font-bold bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white shadow-lg shadow-violet-900/40 transition-all cursor-pointer active:scale-[0.98] disabled:opacity-50"
          >
            {isValidating ? 'Verifying Key…' : 'Access Professor Portal'}
          </button>
        </form>

        <p className="text-[11px] text-gray-500 text-center mt-6 leading-relaxed">
          The key is stored in sessionStorage only — closing this tab clears it.
          <br />
          Local key: <code className="text-gray-400 font-mono">prof-secret-2024</code> (from <code className="text-gray-400">.dev.vars</code>)
        </p>
      </div>
    </div>
  );
}

