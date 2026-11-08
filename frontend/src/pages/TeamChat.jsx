import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { readChatStream } from '../chatStream';
import Icon from '../components/Icon';
import WorkspaceShell from '../components/WorkspaceShell';
import { useWorkspace } from '../workspace/useWorkspace';
import '../styles/team.css';

const API_BASE = import.meta.env.VITE_API_BASE || '';

function relativeTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString();
}

export default function TeamChat() {
  const { id } = useParams();
  const ws = useWorkspace(id);
  const [threads, setThreads] = useState([]);
  const [threadId, setThreadId] = useState(() => crypto.randomUUID());
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [error, setError] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const messagesRef = useRef(null);
  const sheetRef = useRef(null);
  const selectionRef = useRef(0);

  const loadThreads = useCallback(async () => {
    try {
      const response = await ws.authedFetch(`${API_BASE}/api/team/${id}/threads`);
      if (!response.ok) return;
      const json = await response.json();
      setThreads(Array.isArray(json) ? json : []);
    } catch {
      setError('Could not load chats.');
    }
  }, [id, ws.authedFetch]);

  useEffect(() => { loadThreads(); }, [loadThreads, ws.signedIn, ws.needSignIn]);
  useEffect(() => {
    const node = messagesRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);
  useEffect(() => {
    if (!sheetOpen) return undefined;
    const previous = document.activeElement;
    sheetRef.current?.querySelector('button')?.focus();
    function onKey(event) {
      if (event.key === 'Escape') setSheetOpen(false);
      if (event.key !== 'Tab') return;
      const buttons = Array.from(sheetRef.current?.querySelectorAll('button:not(:disabled)') || []);
      if (!buttons.length) return;
      if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons[buttons.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === buttons[buttons.length - 1]) { event.preventDefault(); buttons[0].focus(); }
    }
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [sheetOpen]);

  function newThread() {
    selectionRef.current += 1;
    setThreadId(crypto.randomUUID());
    setMessages([]);
    setLoadingThread(false);
    setError('');
    setSheetOpen(false);
  }

  async function openThread(nextId) {
    const selection = ++selectionRef.current;
    setThreadId(nextId);
    setMessages([]);
    setError('');
    setLoadingThread(true);
    setSheetOpen(false);
    try {
      const response = await ws.authedFetch(`${API_BASE}/api/team/${id}/threads/${encodeURIComponent(nextId)}`);
      if (!response.ok) throw new Error('Could not load chat.');
      const rows = await response.json();
      if (selection === selectionRef.current) setMessages(Array.isArray(rows) ? rows.map((m) => ({ role: m.role, content: m.content })) : []);
    } catch (err) {
      if (selection === selectionRef.current) setError(err.message);
    } finally {
      if (selection === selectionRef.current) setLoadingThread(false);
    }
  }

  async function send(event) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy || loadingThread) return;
    setInput('');
    setError('');
    setBusy(true);
    setMessages((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '', streaming: true }]);
    const updateLast = (fn) => setMessages((prev) => [...prev.slice(0, -1), fn(prev[prev.length - 1])]);
    try {
      const response = await ws.authedFetch(`${API_BASE}/api/team/${id}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: threadId, message: text }),
      });
      if (!response.ok || !response.body) throw new Error(response.status === 401 ? 'Admin token required.' : 'Request failed.');
      await readChatStream(response, (evt) => {
        if (evt.token) updateLast((m) => ({ ...m, content: m.content + evt.token }));
        else if (evt.citations && !evt.done) updateLast((m) => ({ ...m, citations: evt.citations }));
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

  const threadList = <><button className="tc-new" type="button" onClick={newThread} disabled={busy}><Icon name="plus"/>New chat</button><p className="tc-list-label">Your conversations</p><nav className="tc-list" aria-label="Recent chats">{threads.length === 0 && <p className="tc-empty">No chats yet.</p>}{threads.map((thread) => <button key={thread.session_id} className={`tc-thread${thread.session_id === threadId ? ' is-active' : ''}`} type="button" onClick={() => openThread(thread.session_id)} disabled={busy} aria-current={thread.session_id === threadId ? 'true' : undefined}><span>{thread.title || 'Untitled'}</span><time dateTime={thread.last_at || undefined}>{relativeTime(thread.last_at)}</time></button>)}</nav></>;

  return <WorkspaceShell workspace={ws} active="team" fill title="Team chat">
    <div className="tc-layout">
      <aside className="tc-sidebar">{threadList}</aside>
      <section className="tc-chat" aria-label="Team chat conversation">
        <div className="tc-mobile-header"><button type="button" className="tc-chats-button" onClick={() => setSheetOpen(true)}><Icon name="team"/>Chats</button></div>
        <div className="tc-messages" ref={messagesRef}>
          {loadingThread ? <div className="tc-loading" aria-label="Loading chat"><div/><div/></div> : messages.length === 0 && <div className="tc-welcome"><div className="tc-mark"><Icon name="team" size={20}/></div><p className="tc-eyebrow">Your knowledge, with context</p><h2>What would you like to know?</h2><p>Ask about your business or customer conversations. The assistant can draw on your indexed content and recent activity.</p><button type="button" className="tc-suggestion" onClick={() => setInput('What did visitors ask about pricing this week?')}>What did visitors ask about pricing this week?<Icon name="external"/></button></div>}
          {messages.map((m, i) => <div key={i} className={`tc-message ${m.role === 'user' || m.role === 'visitor' ? 'is-user' : 'is-assistant'}`}><div className="tc-message-label">{m.role === 'user' || m.role === 'visitor' ? 'You' : 'Assistant'}</div><div className="tc-message-content">{m.content || (m.streaming ? 'Searching and thinking…' : '')}{m.streaming && <span className="tc-cursor" aria-hidden="true"/>}</div>{Array.isArray(m.citations) && m.citations.length > 0 && <div className="tc-sources" aria-label="Sources"><strong>Sources</strong>{m.citations.map((c, j) => <span key={j}><Icon name="documents" size={14}/>{c.source}</span>)}</div>}</div>)}
        </div>
        {error && <p className="tc-error" role="alert">{error}</p>}
        <form className="tc-composer" onSubmit={send}><textarea rows="1" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form.requestSubmit(); } }} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Message the team assistant" aria-label="Message" disabled={busy || loadingThread}/><button type="submit" disabled={busy || loadingThread || !input.trim()}><Icon name="send"/>{busy ? 'Thinking…' : 'Send'}</button><span>Enter to send · Shift + Enter for a new line</span></form>
      </section>
    </div>
    {sheetOpen && <div className="tc-sheet" role="dialog" aria-modal="true" aria-label="Chats" ref={sheetRef}><div className="tc-sheet-heading"><h2>Chats</h2><button type="button" aria-label="Close chats" onClick={() => setSheetOpen(false)}><Icon name="x" size={20}/></button></div>{threadList}</div>}
  </WorkspaceShell>;
}
