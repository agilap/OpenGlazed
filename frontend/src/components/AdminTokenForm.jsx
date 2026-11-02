import { useState } from 'react';

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
      <label htmlFor={id}>{label} It's in backend/.env, or printed in the backend log at startup.</label>
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
