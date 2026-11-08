import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import AccountSettings from '../components/AccountSettings';
import '../styles/account.css';

const API_BASE = import.meta.env.VITE_API_BASE || '';

export default function Account({ mode }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // Only same-site paths, so the link cannot send people to another site after sign-in.
  const next = /^\/(?![/\\])/.test(params.get('next') || '') ? params.get('next') : '';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(!mode);
  const [error, setError] = useState('');
  const [passwordReset, setPasswordReset] = useState(false);
  useEffect(() => {
    if (mode !== 'login') return;
    fetch(`${API_BASE}/api/auth/config`).then((r) => r.ok ? r.json() : null).then((config) => setPasswordReset(Boolean(config?.passwordReset))).catch(() => {});
  }, [mode]);

  useEffect(() => {
    if (mode) return;
    fetch(`${API_BASE}/api/auth/me`, { credentials: 'include' }).then(async (response) => {
      if (response.status === 401) { navigate('/login', { replace: true }); return; }
      if (!response.ok) throw new Error('Unable to load your workspace.');
      setAccount(await response.json());
    }).catch((err) => setError(err.message)).finally(() => setLoading(false));
  }, [mode, navigate]);

  async function submit(event) {
    event.preventDefault(); setError(''); setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/auth/${mode}`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to continue.');
      navigate(next || '/account');
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  async function logout() {
    try {
      const response = await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', credentials: 'include' });
      if (!response.ok) throw new Error('Unable to sign out.');
      navigate('/login');
    } catch (err) { setError(err.message); }
  }
  const signup = mode === 'signup';
  return <main className="account-page" id="content">
    <div className="account-frame">
      <header className="account-header">
        <Link to="/" className="account-brand">Glazed AI</Link>
        {mode ? <Link to="/">Back to home</Link> : <button className="account-secondary" onClick={logout} type="button"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="M10 17v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2M14 7l5 5-5 5M19 12H8" /></svg>Sign out</button>}
      </header>
      {mode ? <section className="account-auth">
        <div className="account-intro">
          <p className="account-eyebrow">{signup ? 'GET STARTED' : 'WELCOME BACK'}</p>
          <h1>{signup ? 'Create your workspace' : 'Sign in to your workspace'}</h1>
          <p>{signup ? 'One account holds every document workspace, with its conversations, contacts and traces.' : 'Manage your documents, read conversations and check what the agent retrieved.'}</p>
        </div>
        <div className="account-panel">
          <p className="account-meta">// {signup ? 'new account' : 'session'}</p>
          <h2>{signup ? 'Create account' : 'Sign in'}</h2>
          <form onSubmit={submit} className="account-form">
            <label htmlFor="account-email">Email</label>
            <input id="account-email" type="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <label htmlFor="account-password">Password</label>
            <input id="account-password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} minLength={signup ? 12 : undefined} maxLength={1024} value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!error} aria-describedby={[signup && 'account-password-hint', error && 'account-auth-error'].filter(Boolean).join(' ') || undefined} required />
            {signup ? <small id="account-password-hint">Use at least 12 characters.</small> : passwordReset && <small><Link to="/forgot">Forgot password?</Link></small>}
            {error && <p id="account-auth-error" className="account-error" role="alert">{error}</p>}
            <button type="submit" disabled={loading}>{loading && <svg className="account-spinner" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><circle cx="12" cy="12" r="9" opacity=".3" /><path d="M12 3a9 9 0 0 1 9 9" /></svg>}{loading ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}</button>
          </form>
          <p className="account-switch">{signup ? 'Already have an account?' : 'New to Glazed AI?'} <Link to={(signup ? '/login' : '/signup') + (next ? '?next=' + encodeURIComponent(next) : '')}>{signup ? 'Sign in' : 'Create an account'}</Link></p>
        </div>
      </section> : <section className="account-workspace">
        <div className="account-workspace-heading"><div><p className="account-eyebrow">WORKSPACE</p><h1>Your workspaces</h1><p>{account?.user.email}</p></div></div>
        {error && <p className="account-error account-error-light" role="alert">{error}</p>}
        {loading ? <div className="account-grid" role="status" aria-label="Loading workspaces"><div className="account-skeleton" /><div className="account-skeleton" /></div> : <div className="account-grid">
          {(account?.businesses || []).map((business) => {
            const date = business.created_at && new Date(business.created_at);
            return <Link className="account-card" key={business.id} to={`/dashboard/${business.id}/overview`}><strong>{business.name}</strong>{business.document_count != null && <small>{business.document_count} ready documents</small>}{Number(business.open_unanswered) > 0 && <span className="account-unanswered">{business.open_unanswered} unanswered</span>}{date && !Number.isNaN(date.getTime()) && <small>Created {date.toLocaleDateString()}</small>}</Link>;
          })}
          <Link className="account-card account-card-new" to="/workspaces/new"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>New workspace</Link>
        </div>}
      </section>}
      {!mode && account && <AccountSettings user={account.user} />}
    </div>
  </main>;
}
