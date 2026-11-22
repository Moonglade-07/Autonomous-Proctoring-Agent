/**
 * worker/auth/types.ts — Authentication and user role types
 */

export type UserRole = 'student' | 'professor' | 'admin';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  password_hash: string;
  password_salt: string;
  student_id: string | null;
  department: string | null;
  active: number;
  token_version: number;
  created_at: string;
  last_login_at: string | null;
}

export interface SafeUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  student_id: string | null;
  department: string | null;
}

export interface JwtPayload {
  sub: string;
  role: UserRole;
  tv: number;
  iat: number;
  exp: number;
}
