import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Icon from '../../components/Icon';
import { relativeTime } from './Overview';
const API_BASE = import.meta.env.VITE_API_BASE || '';
export default function Conversations({ workspace, id }) {
  const [params, setParams] = useSearchParams();
  const selected = params.get('session');
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!selected) return undefined;
    let current = true;
    setLoading(true); setMessages([]); setError('');
    workspace.authedFetch(`${API_BASE}/api/dashboard/${id}/transcripts?sessionId=${encodeURIComponent(selected)}`).then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Failed to load transcript'); if (current) setMessages(Array.isArray(data) ? data : []); }).catch((err) => { if (current) setError(err.message); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [id, selected, workspace.authedFetch]);
  return <div className={`workspace-conversations${selected ? ' has-selection' : ''}`}><div className="workspace-conversation-list">{workspace.conversations.length ? workspace.conversations.map((chat) => <button type="button" key={chat.session_id} className={`workspace-conversation-row${selected === String(chat.session_id) ? ' is-active' : ''}`} onClick={() => setParams({ session: chat.session_id })}><strong>{chat.title || '(no message)'}</strong><span>{chat.lead_name || chat.lead_email || 'Anonymous'} · {chat.message_count} messages</span><span>{relativeTime(chat.last_at)} {chat.escalated && <em className="workspace-tag">needs reply</em>}</span></button>) : <div className="workspace-empty"><h2>No conversations yet</h2><p>Share the chat with the embed code, or <Link to={`/embed/${id}`}>ask your documents</Link>.</p></div>}</div><div className="workspace-transcript">{selected ? <><div className="workspace-transcript-header"><button type="button" className="workspace-back" onClick={() => setParams({})}><Icon name="arrow-left"/>Back</button><span>Session / {selected}</span></div>{loading ? <div className="workspace-skeletons" aria-label="Loading transcript"><div/><div/></div> : error ? <p className="workspace-empty" role="alert">{error}</p> : messages.length ? <div className="workspace-messages">{messages.map((message, index) => <div key={message.id || index} className={`workspace-message ${message.role === 'visitor' ? 'is-visitor' : ''}`}>{message.content}</div>)}</div> : <p className="workspace-empty">No transcript available for this session.</p>}</> : <div className="workspace-empty">Select a conversation to view its transcript.</div>}</div></div>;
}
