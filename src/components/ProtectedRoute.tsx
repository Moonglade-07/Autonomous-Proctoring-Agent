/**
 * src/components/ProtectedRoute.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Route guard that checks user authentication and authorized roles (Phase 5a).
 * Redirects unauthenticated users to /login preserving target location.
 * Shows ForbiddenPage if user role is not authorized.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ForbiddenPage } from './ForbiddenPage';

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRoles?: ('student' | 'professor' | 'admin')[];
}

export function ProtectedRoute({ children, allowedRoles }: ProtectedRouteProps) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center text-slate-400">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4" />
        <span className="text-xs uppercase tracking-widest font-semibold">Authenticating...</span>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return <ForbiddenPage />;
  }

  return <>{children}</>;
}
