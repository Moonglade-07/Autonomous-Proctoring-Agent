/**
 * src/context/AuthContext.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * React Context + useReducer for Authentication (Phase 5a).
 * Loads /api/auth/me on startup and provides user, login, logout, signup, and loading state.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { createContext, useContext, useReducer, useEffect, useCallback } from 'react';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'student' | 'professor' | 'admin';
  student_id: string | null;
  department: string | null;
  privacy_accepted?: boolean;
  privacy_accepted_at?: string | null;
  created_at?: string;
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
}

type AuthAction =
  | { type: 'AUTH_INIT_START' }
  | { type: 'AUTH_SUCCESS'; payload: AuthUser }
  | { type: 'AUTH_LOGOUT' }
  | { type: 'AUTH_ERROR'; payload: string }
  | { type: 'AUTH_FINISH_LOADING' };

function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case 'AUTH_INIT_START':
      return { ...state, loading: true, error: null };
    case 'AUTH_SUCCESS':
      return { user: action.payload, loading: false, error: null };
    case 'AUTH_LOGOUT':
      return { user: null, loading: false, error: null };
    case 'AUTH_ERROR':
      return { ...state, error: action.payload, loading: false };
    case 'AUTH_FINISH_LOADING':
      return { ...state, loading: false };
    default:
      return state;
  }
}

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string; status?: number }>;
  signup: (data: { email: string; name: string; password: string; student_id?: string }) => Promise<{ success: boolean; error?: string; status?: number }>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(authReducer, {
    user: null,
    loading: true,
    error: null,
  });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        const data = (await res.json()) as { user: AuthUser };
        dispatch({ type: 'AUTH_SUCCESS', payload: data.user });
      } else {
        dispatch({ type: 'AUTH_LOGOUT' });
      }
    } catch {
      dispatch({ type: 'AUTH_LOGOUT' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    dispatch({ type: 'AUTH_INIT_START' });
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const body = (await res.json().catch(() => ({}))) as {
        user?: AuthUser;
        error?: { code?: string; message?: string };
      };

      if (!res.ok) {
        const errorMsg = body.error?.message || 'Login failed';
        dispatch({ type: 'AUTH_ERROR', payload: errorMsg });
        return { success: false, error: errorMsg, status: res.status };
      }

      if (body.user) {
        dispatch({ type: 'AUTH_SUCCESS', payload: body.user });
        return { success: true };
      }

      dispatch({ type: 'AUTH_ERROR', payload: 'Invalid server response' });
      return { success: false, error: 'Invalid server response' };
    } catch (e) {
      const errorMsg = (e as Error).message || 'Network error';
      dispatch({ type: 'AUTH_ERROR', payload: errorMsg });
      return { success: false, error: errorMsg };
    }
  }, []);

  const signup = useCallback(async (data: { email: string; name: string; password: string; student_id?: string }) => {
    dispatch({ type: 'AUTH_INIT_START' });
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      const body = (await res.json().catch(() => ({}))) as {
        user?: AuthUser;
        error?: { code?: string; message?: string };
      };

      if (!res.ok) {
        const errorMsg = body.error?.message || 'Signup failed';
        dispatch({ type: 'AUTH_ERROR', payload: errorMsg });
        return { success: false, error: errorMsg, status: res.status };
      }

      if (body.user) {
        dispatch({ type: 'AUTH_SUCCESS', payload: body.user });
        return { success: true };
      }

      dispatch({ type: 'AUTH_ERROR', payload: 'Invalid server response' });
      return { success: false, error: 'Invalid server response' };
    } catch (e) {
      const errorMsg = (e as Error).message || 'Network error';
      dispatch({ type: 'AUTH_ERROR', payload: errorMsg });
      return { success: false, error: errorMsg };
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {}
    dispatch({ type: 'AUTH_LOGOUT' });
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user: state.user,
        loading: state.loading,
        error: state.error,
        login,
        signup,
        logout,
        refresh,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
