import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { isSupabaseConfigured } from '../lib/supabase';
import { ThemeToggle } from '../components/ThemeToggle';
import { BrandLogo } from '../components/BrandLogo';

export function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(username, password);
      navigate('/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-screen">
      <div className="auth-toggle">
        <ThemeToggle />
      </div>
      <form className="auth-card" onSubmit={onSubmit}>
        <h1 className="auth-brand"><BrandLogo size="lg" /></h1>
        <p className="auth-sub">
          쌍용건설 <strong>스마트 건설기술 플랫폼</strong>에 오신 것을 환영합니다.
        </p>

        {!isSupabaseConfigured && (
          <div className="auth-warn">
            Supabase 환경변수가 설정되지 않았습니다. <code>.env</code>에
            <code>VITE_SUPABASE_URL</code> / <code>VITE_SUPABASE_ANON_KEY</code>를 추가하세요.
          </div>
        )}

        <label>
          아이디
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </label>
        <label>
          비밀번호
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>

        {error && <div className="auth-error">{error}</div>}

        <button type="submit" disabled={busy || !username || !password}>
          {busy ? '로그인 중…' : '로그인'}
        </button>
      </form>

      <footer className="auth-footer">
        <span className="footer-copy">
          © Copyright <strong>Ssangyong E&amp;C</strong>. All Rights Reserved
        </span>
        <span className="footer-credit">
          Designed by{' '}
          <span className="footer-team">
            Civil Engineering Technology Team, Smart Construction Part
          </span>
        </span>
      </footer>
    </main>
  );
}
