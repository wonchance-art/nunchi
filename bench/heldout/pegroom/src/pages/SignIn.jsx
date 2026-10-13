import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

export default function SignIn() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async e => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/sign-in', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      if (!res.ok) { setError('That email and password don\'t match a member. Check them and try again.'); return; }
      const next = params.get('next');
      navigate(next && next.startsWith('/') ? next : '/dashboard');
    } catch {
      setError('We couldn\'t reach Pegroom. Check your connection and try again.');
    } finally { setBusy(false); }
  };

  return (
    <div className="auth-card card">
      <h1>Sign in</h1>
      <p>Use the email address you gave at the front desk.</p>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" className="input" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn btn-block" type="submit" disabled={busy}>Sign in</button>
      </form>
      <p className="muted" style={{ marginTop: 16 }}>Trouble signing in? Write to desk@example.org and a steward will reset your password.</p>
      <p className="muted">Not a member yet? <Link to="/plans">See the plans</Link></p>
    </div>
  );
}
