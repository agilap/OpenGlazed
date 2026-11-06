import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE || '';

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : 'never';
}

export default function ApiKeys({ businessId, onUnauthorized }) {
  const [keys, setKeys] = useState([]);
  const [name, setName] = useState('');
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const origin = API_BASE || window.location.origin;
  const shownKey = created?.key || 'ogk_YOUR_KEY';

  async function request(path = '', options = {}) {
    const headers = options.body ? { 'Content-Type': 'application/json' } : {};
    const response = await fetch(`${API_BASE}/api/keys/${businessId}${path}`, { ...options, headers, credentials: 'include' });
    if (response.status === 401) onUnauthorized?.();
    const json = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || 'Request failed');
    return json;
  }

  async function refresh() {
    try {
      setKeys((await request()).keys);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { refresh(); }, [businessId]);

  async function create(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      setCreated((await request('', { method: 'POST', body: JSON.stringify({ name: name.trim() }) })).key);
      setName('');
      refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key) {
    setError('');
    try {
      await request(`/${key.id}`, { method: 'DELETE' });
      if (created?.id === key.id) setCreated(null);
      refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function copy(label, text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(''), 2000);
    } catch (_error) {
      setCopied('');
    }
  }

  const examples = [
    ['Ask a question', `curl ${origin}/api/v1/ask \\\n  -H "Authorization: Bearer ${shownKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"question": "How long do customers have to request a refund?"}'`],
    ['Upload a text document', `curl ${origin}/api/v1/documents \\\n  -H "Authorization: Bearer ${shownKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"filename": "faq.md", "text": "# Hours\\nOpen 9 to 5."}'`],
    ['Upload a PDF', `curl ${origin}/api/v1/documents \\\n  -H "Authorization: Bearer ${shownKey}" \\\n  -H "Content-Type: application/json" \\\n  -d "{\\"filename\\": \\"policy.pdf\\", \\"data\\": \\"$(base64 -w0 policy.pdf)\\"}"`],
  ];

  return (
    <div className="apikeys">
      <form className="apikeys-create" onSubmit={create}>
        <label htmlFor={`apikey-name-${businessId}`}>New key name</label>
        <input id={`apikey-name-${businessId}`} className="dashboard-token-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Support portal" maxLength={80} required />
        <button className="dashboard-action-primary" type="submit" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create key'}</button>
      </form>

      {created && (
        <div className="apikeys-reveal" role="status">
          <p><strong>Copy this key now.</strong> It won't be shown again.</p>
          <div className="apikeys-reveal-row">
            <code>{created.key}</code>
            <button className="dashboard-action" type="button" onClick={() => copy('key', created.key)}>{copied === 'key' ? 'Copied!' : 'Copy'}</button>
          </div>
        </div>
      )}

      {error && <p className="doclib-error" role="alert">{error}</p>}

      {keys.length > 0 ? (
        <ul className="doclib-list">
          {keys.map((key) => (
            <li key={key.id}>
              <span className="doclib-name">
                <strong>{key.name}</strong>
                <small>{key.prefix}… · created {formatDate(key.created_at)} · last used {formatDate(key.last_used_at)}</small>
              </span>
              <button type="button" className="doclib-remove" onClick={() => revoke(key)} aria-label={`Revoke ${key.name}`}>Revoke</button>
            </li>
          ))}
        </ul>
      ) : <p className="doclib-note">No active keys.</p>}

      <div className="apikeys-docs">
        <p className="apikeys-endpoints">
          <code>POST /api/v1/ask</code> <code>GET /api/v1/documents</code> <code>POST /api/v1/documents</code> <code>GET /api/v1/documents/:id</code> <code>DELETE /api/v1/documents/:id</code>
        </p>
        {examples.map(([label, code]) => (
          <div key={label} className="apikeys-example">
            <div className="apikeys-example-head"><span>{label}</span><button className="dashboard-action" type="button" onClick={() => copy(label, code)}>{copied === label ? 'Copied!' : 'Copy'}</button></div>
            <pre>{code}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}
