import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { relativeTime } from './Overview';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const tabs = [['unanswered', 'Unanswered'], ['off_topic', 'Off-topic'], ['blocked', 'Flagged']];
export default function Inbox({ workspace, id }) {
  const [tab, setTab] = useState('unanswered');
  const [resolved, setResolved] = useState(false);
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [answering, setAnswering] = useState(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const response = await workspace.authedFetch(`${API_BASE}/api/inbox/${id}?status=${tab}&state=${resolved ? 'resolved' : 'open'}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load inbox.');
      setItems(Array.isArray(data.items) ? data.items : []); setCounts(data.counts || {}); workspace.setInboxCounts(data.counts || {});
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }, [id, tab, resolved, workspace.authedFetch, workspace.setInboxCounts]);
  useEffect(() => { load(); }, [load]);
  async function update(item, isAnswer) {
    setBusy(true); setError('');
    try {
      const response = await workspace.authedFetch(`${API_BASE}/api/inbox/${id}/${item.id}${isAnswer ? '/answer' : ''}`, { method: isAnswer ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(isAnswer ? { answer: answer.trim() } : { resolved: !resolved }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not update this question.');
      setAnswering(null); setAnswer(''); setNotice(isAnswer ? 'Answer added to knowledge and question resolved.' : resolved ? 'Question reopened.' : 'Question resolved.'); await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const empty = { unanswered: "No unanswered questions. Questions your documents can't answer will show up here.", off_topic: 'No off-topic questions.', blocked: 'No flagged questions.' };
  return <div className="workspace-inbox"><div className="inbox-toolbar"><div className="inbox-tabs" role="tablist" aria-label="Inbox categories">{tabs.map(([key, label]) => <button role="tab" aria-selected={tab === key} className={tab === key ? 'is-active' : ''} key={key} onClick={() => { setTab(key); setNotice(''); }} type="button">{label} <span>{counts[key] ?? 0}</span></button>)}</div><label className="inbox-toggle"><input type="checkbox" checked={resolved} onChange={(e) => setResolved(e.target.checked)}/> Show resolved</label></div>{notice && <p className="workspace-notice" role="status">{notice}</p>}{error && <p className="workspace-field-error" role="alert">{error}</p>}{loading ? <div className="workspace-skeletons" aria-label="Loading inbox"><div/><div/></div> : items.length ? <div className="inbox-list">{items.map((item) => <article className="workspace-card inbox-item" key={item.id}><div className="inbox-meta"><span className="workspace-chip">{item.channel}</span><time>{relativeTime(item.created_at)}</time></div><h2>{item.question}</h2>{item.answer && <details className="inbox-reply"><summary><span>Assistant reply</span><span className="inbox-reply-preview">{item.answer}</span></summary><p>{item.answer}</p></details>}<div className="inbox-actions">{!resolved && <button className="workspace-button" type="button" onClick={() => { setAnswering(item.id); setAnswer(''); }}>Answer and add to knowledge</button>}<button className="workspace-button" type="button" disabled={busy} onClick={() => update(item, false)}>{resolved ? 'Reopen' : 'Mark resolved'}</button>{item.channel === 'widget' && item.session_id && <Link className="workspace-button" to={`/dashboard/${id}/conversations?session=${encodeURIComponent(item.session_id)}`}>View conversation</Link>}</div>{answering === item.id && <form className="inbox-answer" onSubmit={(e) => { e.preventDefault(); update(item, true); }}><label htmlFor={`answer-${item.id}`}>Your answer</label><textarea id={`answer-${item.id}`} required maxLength={4000} value={answer} onChange={(e) => setAnswer(e.target.value)}/><div className="inbox-actions"><button className="workspace-button workspace-button--primary" disabled={busy || !answer.trim()} type="submit">{busy ? 'Adding…' : 'Add answer'}</button><button className="workspace-button" type="button" onClick={() => setAnswering(null)}>Cancel</button></div></form>}</article>)}</div> : <div className="workspace-card workspace-empty">{resolved ? 'No resolved questions in this category.' : empty[tab]}</div>}</div>;
}
