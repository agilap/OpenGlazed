import { useState } from 'react';
import { Link } from 'react-router-dom';

export default function AdminTokenForm({ id, label, initialToken, rejected, onSubmit }) {
  const [draft, setDraft] = useState(initialToken);

  return (
    <form
      className="dashboard-token-banner"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(draft.trim());
      }}
    >
      <label htmlFor={id}>{label} You can also <Link to="/login">sign in</Link> with your account.</label>
      <input
        id={id}
        type="password"
        value={draft}
        placeholder="ADMIN_TOKEN"
        autoComplete="off"
        onChange={(event) => setDraft(event.target.value)}
        className="dashboard-token-input"
        aria-invalid={rejected}
        required
      />
      <button type="submit" className="dashboard-action-primary">Load</button>
      {rejected && <p className="dashboard-token-error" role="alert">That token was rejected.</p>}
    </form>
  );
}
