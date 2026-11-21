/**
 * src/components/ProfessorNav.tsx — Top navigation bar for professor area (Phase 4c-1)
 *
 * Restructured: Navigation is now strictly "Exams".
 * Global Question Bank is removed.
 */
import { Link, useLocation } from 'react-router-dom';
import { clearProfessorKey } from '../hooks/useProfessorApi';

export function ProfessorNav({ onKeyChange }: { onKeyChange?: () => void }) {
  const location = useLocation();

  function handleLogout() {
    clearProfessorKey();
    if (onKeyChange) {
      onKeyChange();
    } else {
      window.location.reload();
    }
  }

  const isExamsActive = location.pathname.startsWith('/professor/exams') || location.pathname === '/professor';

  return (
    <nav style={navStyle}>
      <div style={brand}>
        <span style={{ fontSize: 20 }}>🎓</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#f1f5f9' }}>APA Professor</span>
      </div>
      <div style={links}>
        <Link
          to="/professor/exams"
          style={{
            ...linkStyle,
            background: isExamsActive ? 'rgba(99,102,241,0.2)' : 'transparent',
            color: isExamsActive ? '#818cf8' : '#94a3b8',
            borderBottom: isExamsActive ? '2px solid #818cf8' : '2px solid transparent',
          }}
        >
          📋 Exams
        </Link>
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
        <button
          onClick={handleLogout}
          style={{
            background: 'rgba(255,255,255,0.06)',
            color: '#94a3b8',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'all 0.15s',
          }}
          title="Change or clear the professor secret key"
        >
          🔑 Change Key
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
