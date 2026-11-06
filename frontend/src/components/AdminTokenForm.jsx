import { useState } from 'react';
import { Link } from 'react-router-dom';
import '../styles/account.css';

export default function AdminTokenForm({ id, label, initialToken, rejected, onSubmit }) {
  const [draft, setDraft] = useState(initialToken);
  return <form className="access-notice" onSubmit={(event) => { event.preventDefault(); onSubmit(draft.trim()); }}>
    <div className="access-notice-heading"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16v1" /></svg><div><h2>This workspace needs access</h2><p>{label} You can also <Link to="/login">sign in</Link> with your account.</p></div></div>
    <div className="access-notice-fields"><label htmlFor={id}>Admin token</label><input id={id} type="password" value={draft} placeholder="ADMIN_TOKEN" autoComplete="off" onChange={(event) => setDraft(event.target.value)} aria-invalid={rejected || undefined} aria-describedby={rejected ? `${id}-error` : undefined} required /><button type="submit">Unlock</button></div>
    {rejected && <p id={`${id}-error`} className="access-notice-error" role="alert">That token was rejected.</p>}
  </form>;
}
