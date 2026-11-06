import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import '../styles/account.css';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const copy = {
  forgot: ['Reset your password', 'Enter your account email. If it matches an account, we will send a reset link that works once for one hour.'],
  reset: ['Choose a new password', 'This signs you out on every other device.'],
  verify: ['Confirm your email', ''],
};

async function post(path, body) {
  const response = await fetch(`${API_BASE}/api/auth/${path}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Something went wrong. Try again.');
}

// Links carry the token in the URL fragment so it never reaches server logs or Referer headers.
function useFragmentToken() {
  const [token] = useState(() => window.location.hash.slice(1));
  useEffect(() => { if (window.location.hash) window.history.replaceState(null, '', window.location.pathname); }, []);
  return token;
}

export default function AccountRecovery({ mode }) {
  const navigate = useNavigate();
  const token = useFragmentToken();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(mode === 'verify');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const verified = useRef(false);

  useEffect(() => {
    if (mode !== 'verify' || verified.current) return;
    verified.current = true;
    post('verify', { token }).then(() => setDone('Your email is confirmed.')).catch((err) => setError(err.message)).finally(() => setBusy(false));
  }, [mode, token]);

  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (mode === 'forgot') { await post('forgot', { email }); setDone('If that email has an account, a reset link is on its way.'); }
      else { await post('reset', { token, password }); navigate('/account'); }
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  const [title, intro] = copy[mode];
  return <main className="account-page" id="content"><div className="account-frame">
    <header className="account-header"><Link to="/" className="account-brand">Glazed AI</Link><Link to="/login">Sign in</Link></header>
    <section className="account-create">
      <p className="account-eyebrow">ACCOUNT</p><h1>{title}</h1>{intro && <p>{intro}</p>}
      {done ? <p role="status">{done} <Link to={mode === 'verify' ? '/account' : '/login'}>{mode === 'verify' ? 'Go to your workspaces' : 'Back to sign in'}</Link></p>
        : mode === 'verify' ? (busy ? <p role="status">Confirming…</p> : <p className="account-error account-error-light" role="alert">{error} <Link to="/account">Send a new link from your account</Link></p>)
        : mode === 'reset' && !token ? <p className="account-error account-error-light" role="alert">This link is incomplete. <Link to="/forgot">Request a new one</Link>.</p>
        : <form className="account-create-form" onSubmit={submit}>
          {mode === 'forgot'
            ? <><label htmlFor="recover-email">Email</label><input id="recover-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254}/></>
            : <><label htmlFor="recover-password">New password</label><input id="recover-password" type="password" autoComplete="new-password" minLength={12} maxLength={1024} value={password} onChange={(e) => setPassword(e.target.value)} required aria-describedby="recover-hint"/><small id="recover-hint">Use at least 12 characters.</small></>}
          {error && <p className="account-error account-error-light" role="alert">{error}</p>}
          <button className="account-primary" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'forgot' ? 'Send reset link' : 'Save password'}</button>
        </form>}
    </section>
  </div></main>;
}
