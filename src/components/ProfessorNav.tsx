/**
 * src/components/ProfessorNav.tsx — Top navigation bar for professor area (Phase 4c-1)
 *
 * Restructured: Navigation is now strictly "Exams".
 * Global Question Bank is removed.
 */
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function ProfessorNav({ onKeyChange }: { onKeyChange?: () => void }) {
  const location = useLocation();
  const { user, logout } = useAuth();

  async function handleLogout() {
    await logout();
    if (onKeyChange) {
      onKeyChange();
    } else {
      window.location.href = '/login';
    }
  }

  return (
    <nav style={navStyle}>
      <div style={brand}>
        <span style={{ fontSize: 20 }}>🎓</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#f1f5f9' }}>APA Professor</span>
      </div>
      <div style={links}>
        <Link
          to="/professor"
          style={{
            ...linkStyle,
            background: location.pathname === '/professor' ? 'rgba(99,102,241,0.2)' : 'transparent',
            color: location.pathname === '/professor' ? '#818cf8' : '#94a3b8',
            borderBottom: location.pathname === '/professor' ? '2px solid #818cf8' : '2px solid transparent',
          }}
        >
          📊 Dashboard
        </Link>
        <Link
          to="/professor/exams"
          style={{
            ...linkStyle,
            background: location.pathname.startsWith('/professor/exams') ? 'rgba(99,102,241,0.2)' : 'transparent',
            color: location.pathname.startsWith('/professor/exams') ? '#818cf8' : '#94a3b8',
            borderBottom: location.pathname.startsWith('/professor/exams') ? '2px solid #818cf8' : '2px solid transparent',
          }}
        >
          📋 Exams
        </Link>
        <Link
          to="/professor/profile"
          style={{
            ...linkStyle,
            background: location.pathname === '/professor/profile' ? 'rgba(99,102,241,0.2)' : 'transparent',
            color: location.pathname === '/professor/profile' ? '#818cf8' : '#94a3b8',
            borderBottom: location.pathname === '/professor/profile' ? '2px solid #818cf8' : '2px solid transparent',
          }}
        >
          👤 Profile
        </Link>
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
        {user && (
          <span style={{ fontSize: 13, color: '#94a3b8' }}>
            <span style={{ color: '#f1f5f9', fontWeight: 600 }}>{user.name}</span>{' '}
            <span style={{
              fontSize: 11,
              padding: '2px 6px',
              borderRadius: 4,
              background: user.role === 'admin' ? 'rgba(239,68,68,0.2)' : 'rgba(99,102,241,0.2)',
              color: user.role === 'admin' ? '#f87171' : '#a5b4fc',
              textTransform: 'uppercase',
              fontWeight: 700,
            }}>
              {user.role}
            </span>
          </span>
        )}
        <button
          onClick={() => void handleLogout()}
          style={{
            background: 'rgba(255,255,255,0.06)',
            color: '#f87171',
            border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 6,
            padding: '4px 12px',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'all 0.15s',
          }}
          title="Sign out of your account"
        >
          🚪 Sign Out
        </button>
      </div>
    </nav>
  );
}

const navStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 32,
  padding: '0 32px',
  height: 52,
  background: 'rgba(15,23,42,0.95)',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
  backdropFilter: 'blur(10px)',
  position: 'sticky',
  top: 0,
  zIndex: 100,
};

const brand: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexShrink: 0,
};

const links: React.CSSProperties = {
  display: 'flex',
  gap: 4,
};

const linkStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 14px',
  borderRadius: '6px 6px 0 0',
  fontSize: 13,
  fontWeight: 600,
  textDecoration: 'none',
  transition: 'all 0.15s',
};
