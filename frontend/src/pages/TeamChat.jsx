import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { readChatStream } from '../chatStream';

const API_BASE = import.meta.env.VITE_API_BASE || '';

export default function TeamChat() {
  const { id: businessId } = useParams();
  const [adminToken, setAdminToken] = useState(() => localStorage.getItem('glazed_admin_token') || '');
  const [needToken, setNeedToken] = useState(false);
  const [threads, setThreads] = useState([]);
  const [threadId, setThreadId] = useState(() => crypto.randomUUID());
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef(null);

  async function authedFetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (adminToken) headers['Authorization'] = `Bearer ${adminToken}`;
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) setNeedToken(true);
    return response;
  }

  async function loadThreads() {
    const response = await authedFetch(`${API_BASE}/api/team/${businessId}/threads`);
    if (!response.ok) return;
    const json = await response.json();
    setThreads(Array.isArray(json) ? json : []);
  }

  useEffect(() => {
    if (adminToken) loadThreads();
  }, [businessId, adminToken]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  function saveToken(value) {
    setAdminToken(value);
    setNeedToken(false);
    if (value) localStorage.setItem('glazed_admin_token', value);
    else localStorage.removeItem('glazed_admin_token');
  }

  function newThread() {
    setThreadId(crypto.randomUUID());
    setMessages([]);
    setError('');
  }

  async function openThread(id) {
    setThreadId(id);
    setMessages([]);
    setError('');
    const response = await authedFetch(`${API_BASE}/api/team/${businessId}/threads/${encodeURIComponent(id)}`);
    if (!response.ok) return;
    const rows = await response.json();
    setMessages(Array.isArray(rows) ? rows.map((m) => ({ role: m.role, content: m.content })) : []);
  }

  async function send(event) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    setInput('');
    setError('');
    setBusy(true);
    setMessages((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '', streaming: true }]);

    const updateLast = (fn) => setMessages((prev) => [...prev.slice(0, -1), fn(prev[prev.length - 1])]);

    try {
      const response = await authedFetch(`${API_BASE}/api/team/${businessId}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: threadId, message: text }),
      });
      if (!response.ok || !response.body) throw new Error(response.status === 401 ? 'Admin token required.' : 'Request failed.');

      await readChatStream(response, (evt) => {
        if (evt.token) updateLast((m) => ({ ...m, content: m.content + evt.token }));
        else if (evt.done) updateLast((m) => ({ ...m, streaming: false, citations: evt.citations || [] }));
      });
      loadThreads();
    } catch (err) {
      setError(err.message);
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dashboard-shell team-shell">
      <aside className="dashboard-sidebar">
        <div>
          <div className="dashboard-wordmark">Glazed</div>
          <button className="dashboard-action-primary team-new" type="button" onClick={newThread}>New chat</button>
          <nav className="dashboard-nav team-threads" aria-label="Recent chats">
            {threads.length === 0 ? <p className="dashboard-empty">No chats yet.</p> : null}
            {threads.map((t) => (
              <button
                key={t.session_id}
                type="button"
                className={`dashboard-nav-item ${t.session_id === threadId ? 'dashboard-nav-item--active' : ''}`}
                onClick={() => openThread(t.session_id)}
                title={t.title || ''}
              >
                <span className="team-thread-title">{t.title || 'Untitled'}</span>
              </button>
            ))}
          </nav>
        </div>
        <div className="dashboard-sidebar-footer">
          <Link to={`/dashboard/${businessId}`} className="dashboard-back-link">← Dashboard</Link>
        </div>
      </aside>

      <main className="dashboard-main team-main">
        {(!adminToken || needToken) && (
          <section className="dashboard-token-banner">
            <span>Team chat is protected. Paste your ADMIN_TOKEN:</span>
            <input
              type="password"
              value={adminToken}
              placeholder="ADMIN_TOKEN"
              onChange={(e) => saveToken(e.target.value)}
              className="dashboard-token-input"
            />
          </section>
        )}

        <div className="team-messages">
          {messages.length === 0 ? (
            <p className="dashboard-empty">
              Ask about your business or your customers — e.g. “What did visitors ask about pricing this week?”
            </p>
          ) : null}
          {messages.map((m, i) => (
            <div key={i} className={`transcript-bubble ${m.role === 'user' ? 'visitor' : 'assistant'} team-bubble`}>
              <div>{m.content || (m.streaming ? '…' : '')}</div>
              {Array.isArray(m.citations) && m.citations.length > 0 && (
                <div className="team-sources">
                  {m.citations.map((c, j) => <span key={j}>{c.source}</span>)}
                </div>
              )}
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {error ? <p className="team-error" role="alert">{error}</p> : null}

        <form className="team-input" onSubmit={send}>
          <input
            className="dashboard-token-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message the team assistant"
            aria-label="Message"
            disabled={busy}
          />
          <button className="dashboard-action-primary" type="submit" disabled={busy || !input.trim()}>
            {busy ? 'Thinking…' : 'Send'}
          </button>
        </form>
      </main>
    </div>
  );
}
