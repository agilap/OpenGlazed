import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

const API_BASE = import.meta.env.VITE_API_BASE || '';

export default function Account({ mode }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(!mode);
  const [error, setError] = useState('');

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
      localStorage.removeItem('glazed_admin_token');
      navigate('/account');
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
  return <main className="account-page">
    <div className="account-frame">
      <header className="account-header">
        <Link to="/" className="account-brand">Glazed AI</Link>
        <Link to="/">Back to home</Link>
      </header>
      {mode ? <section className="account-auth">
        <div className="account-intro">
          <p className="account-eyebrow">{signup ? 'GET STARTED' : 'WELCOME BACK'}</p>
          <h1>{signup ? 'Create your workspace' : 'Sign in to your workspace'}</h1>
          <p>{signup ? 'One account holds every assistant you index, with its leads, conversations and traces.' : 'Manage your assistants, read conversations and check what the agent retrieved.'}</p>
        </div>
        <div className="account-panel">
          <p className="account-meta">// {signup ? 'new account' : 'session'}</p>
          <h2>{signup ? 'Create account' : 'Sign in'}</h2>
          <form onSubmit={submit} className="account-form">
            <label htmlFor="account-email">Email</label>
            <input id="account-email" type="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <label htmlFor="account-password">Password</label>
            <input id="account-password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} minLength={signup ? 12 : undefined} maxLength={1024} value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby={signup ? 'account-password-hint' : undefined} required />
            {signup && <small id="account-password-hint">Use at least 12 characters.</small>}
            {error && <p className="account-error" role="alert">{error}</p>}
            <button type="submit" disabled={loading}>{loading ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}</button>
          </form>
          <p className="account-switch">{signup ? 'Already have an account?' : 'New to Glazed AI?'} <Link to={signup ? '/login' : '/signup'}>{signup ? 'Sign in' : 'Create an account'}</Link></p>
        </div>
      </section> : <section className="account-workspace">
        <div className="account-workspace-heading">
          <div><p className="account-eyebrow">WORKSPACE</p><h1>Your assistants</h1><p>{account?.user.email}</p></div>
          <div className="account-actions">
            <Link className="account-primary" to="/#start">Index a website</Link>
            <button className="account-secondary" onClick={logout} type="button">Sign out</button>
          </div>
        </div>
        {error && <p className="account-error" role="alert">{error}</p>}
        {loading ? <p>Loading your workspace…</p> : account?.businesses.length ? <div className="account-list">{account.businesses.map((business) => <Link key={business.id} to={`/dashboard/${business.id}`}><span><strong>{business.name}</strong><small>{business.url}</small></span><span className="account-status">{business.ingest_status || 'pending'} →</span></Link>)}</div> : <div className="account-empty"><h2>No assistants yet</h2><p>Index your website to create your first assistant.</p></div>}
      </section>}
    </div>
  </main>;
}
