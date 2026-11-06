import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../../components/Icon';

const API_BASE = import.meta.env.VITE_API_BASE || '';
export function relativeTime(value) {
  if (!value) return '';
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return '';
  const units = [[31536000, 'year'], [2592000, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  const unit = units.find(([amount]) => Math.abs(seconds) >= amount);
  return unit ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-Math.round(seconds / unit[0]), unit[1]) : 'just now';
}
function Actions({ id }) { return <><Link className="workspace-button" to={`/team/${id}`}><Icon name="team"/>Open team chat</Link><Link className="workspace-button workspace-button--primary" to={`/dashboard/${id}/documents`}><Icon name="upload"/>Upload files</Link></>; }
export default function Overview({ workspace, id }) {
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { stats, documents, conversations, business } = workspace;
  const ready = documents.filter((doc) => doc.status === 'ready').length;
  const indexing = documents.filter((doc) => ['queued', 'processing'].includes(doc.status)).length;
  const failed = documents.filter((doc) => doc.status === 'error').length;
  useEffect(() => { workspace.authedFetch(`${API_BASE}/api/keys/${id}`).then((response) => response.ok ? response.json() : null).then((data) => setHasKey(Boolean(data?.keys?.length))).catch(() => {}); }, [id, workspace.authedFetch]);
  async function reingest() {
    if (!business?.url || !window.confirm('Re-ingest this website now?')) return;
    setBusy(true); setError('');
    try { const response = await workspace.authedFetch(`${API_BASE}/api/ingest/${id}`, { method: 'POST' }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Failed to trigger ingest'); await workspace.reload(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const tiles = [['Documents', stats.documents], ['Questions answered', stats.questionsAnswered], ['Unanswered', stats.unansweredRate == null ? null : `${Math.round(stats.unansweredRate * 100)}%`, 'of conversations'], ['Median answer time', stats.medianLatencyMs == null ? null : `${(stats.medianLatencyMs / 1000).toFixed(1)}s`]];
  return <><div className="workspace-stats">{tiles.map(([label, value, hint]) => <article className="workspace-stat" key={label}><span>{label}</span><strong className={value == null ? 'is-empty' : undefined}>{value ?? '—'}</strong>{hint && <small>{hint}</small>}</article>)}</div>{business?.url && <div className="workspace-reingest"><button className="workspace-button" type="button" disabled={busy} onClick={reingest}><Icon name="refresh"/>{busy ? 'Re-ingesting…' : 'Re-ingest website'}</button>{error && <span role="alert">{error}</span>}</div>}<div className="workspace-overview-grid"><section className="workspace-card workspace-recent"><div className="workspace-card-heading"><h2>Recent questions</h2><Link to={`/dashboard/${id}/conversations`}>View all</Link></div>{conversations.length ? <div className="workspace-list">{conversations.slice(0, 6).map((chat) => <Link className="workspace-row" key={chat.session_id} to={`/dashboard/${id}/conversations?session=${encodeURIComponent(chat.session_id)}`}><span><strong>{chat.title || '(no message)'}</strong>{chat.escalated && <small className="workspace-tag">needs reply</small>}</span><time>{relativeTime(chat.last_at)}</time></Link>)}</div> : <div className="workspace-recent-empty"><span className="workspace-recent-icon"><Icon name="conversations" size={20}/></span><h3>No questions yet</h3><p>Questions from the shared chat show up here.</p><a className="workspace-button" href={`/embed/${id}`} target="_blank" rel="noreferrer">Open shareable chat <Icon name="external"/></a></div>}</section>{ready ? <section className="workspace-card"><div className="workspace-card-heading"><h2>Documents</h2><Link to={`/dashboard/${id}/documents`}>Manage documents</Link></div><p className="workspace-summary">{ready} ready · {indexing} indexing · {failed} failed</p><div className="workspace-list">{[...documents].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)).slice(0, 4).map((doc) => <div className="workspace-row" key={doc.id}><strong>{doc.filename}</strong><span className="workspace-chip">{doc.source_type || 'file'}</span></div>)}</div></section> : <section className="workspace-card"><div className="workspace-card-heading"><h2>Get started</h2></div><div className="workspace-steps">{[[ready > 0, 'Upload a document', 'documents'], [stats.questionsAnswered > 0, 'Ask a question', null], [hasKey, 'Create an API key', 'api'], [false, 'Share the chat', 'embed']].map(([done, label, path]) => <Link key={label} to={path ? `/dashboard/${id}/${path}` : `/embed/${id}`}><span className={`workspace-step${done ? ' is-done' : ''}`}>{done && <Icon name="check"/>}</span>{label}</Link>)}</div></section>}</div></>;
}
Overview.Actions = Actions;
