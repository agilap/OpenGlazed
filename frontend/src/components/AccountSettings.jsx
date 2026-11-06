import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const API_BASE = import.meta.env.VITE_API_BASE || '';

async function call(method, path, body) {
  const response = await fetch(`${API_BASE}/api/auth/${path}`, { method, credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Something went wrong. Try again.');
}

function useAction() {
  const [state, setState] = useState({ busy: false, error: '', done: '' });
  async function run(task, done) {
    setState({ busy: true, error: '', done: '' });
    try { await task(); setState({ busy: false, error: '', done }); } catch (err) { setState({ busy: false, error: err.message, done: '' }); }
  }
  return [state, run];
}
function Result({ state, id }) {
  return <>{state.error && <p id={id} className="account-error account-error-light" role="alert">{state.error}</p>}{state.done && <p role="status">{state.done}</p>}</>;
}

export default function AccountSettings({ user }) {
  const navigate = useNavigate();
  const [current, setCurrent] = useState(''); const [next, setNext] = useState('');
  const [deletePassword, setDeletePassword] = useState(''); const [confirm, setConfirm] = useState('');
  const [verify, runVerify] = useAction(); const [password, runPassword] = useAction(); const [everywhere, runEverywhere] = useAction(); const [removal, runRemoval] = useAction();

  return <section className="account-create" aria-labelledby="settings-heading">
    <p className="account-eyebrow">ACCOUNT</p><h1 id="settings-heading">Account settings</h1>
    {!user.email_verified && <div className="account-create-form" role="region" aria-label="Email confirmation">
      <p>Confirm {user.email} to create workspaces. Check your inbox for the link.</p>
      <button className="account-secondary" type="button" disabled={verify.busy} onClick={() => runVerify(() => call('POST', 'verify/resend'), 'A new link is on its way.')}>Send a new link</button>
      <Result state={verify}/>
    </div>}
    <form className="account-create-form" onSubmit={(e) => { e.preventDefault(); runPassword(async () => { await call('POST', 'password', { current, password: next }); setCurrent(''); setNext(''); }, 'Password changed. Other devices are signed out.'); }}>
      <h2>Change password</h2>
      <label htmlFor="settings-current">Current password</label><input id="settings-current" type="password" autoComplete="current-password" maxLength={1024} value={current} onChange={(e) => setCurrent(e.target.value)} required/>
      <label htmlFor="settings-new">New password</label><input id="settings-new" type="password" autoComplete="new-password" minLength={12} maxLength={1024} value={next} onChange={(e) => setNext(e.target.value)} required/>
      <Result state={password}/>
      <button className="account-primary" type="submit" disabled={password.busy}>{password.busy ? 'Saving…' : 'Change password'}</button>
    </form>
    <div className="account-create-form">
      <h2>Sessions</h2><p>Sign out of every browser and device, including this one.</p>
      <button className="account-secondary" type="button" disabled={everywhere.busy} onClick={() => runEverywhere(async () => { await call('POST', 'logout-all'); navigate('/login'); }, '')}>Sign out everywhere</button>
      <Result state={everywhere}/>
    </div>
    <form className="account-create-form" onSubmit={(e) => { e.preventDefault(); runRemoval(async () => { await call('DELETE', 'account', { password: deletePassword, confirm }); navigate('/'); }, ''); }}>
      <h2>Delete account</h2><p>This permanently deletes your account and every workspace it owns, with their documents, conversations and leads. It cannot be undone.</p>
      <label htmlFor="settings-confirm">Type <strong>{user.email}</strong> to confirm</label><input id="settings-confirm" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} required/>
      <label htmlFor="settings-delete-password">Password</label><input id="settings-delete-password" type="password" autoComplete="current-password" maxLength={1024} value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} required/>
      <Result state={removal}/>
      <button className="account-secondary" type="submit" disabled={removal.busy || confirm !== user.email}>{removal.busy ? 'Deleting…' : 'Delete account and workspaces'}</button>
    </form>
  </section>;
}
