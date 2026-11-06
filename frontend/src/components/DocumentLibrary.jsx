import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const ACCEPT = '.pdf,.docx,.md,.markdown,.txt,.csv,.json';
const MAX_BYTES = 18 * 1024 * 1024;
const BUSY = ['queued', 'processing', 'deleting'];
const STATUS_LABEL = { queued: 'queued', processing: 'indexing', deleting: 'removing', ready: 'ready', error: 'failed' };

function readFile(file) {
  if (!/\.(pdf|docx)$/i.test(file.name)) return file.text().then((text) => ({ filename: file.name, text }));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ filename: file.name, data: String(reader.result).split(',')[1] || '' });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function DocumentLibrary({ businessId, adminToken, tone = 'light', onDocuments, onUnauthorized }) {
  const [documents, setDocuments] = useState([]);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [pasted, setPasted] = useState('');

  async function request(path = '', options = {}) {
    const headers = { ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}) };
    const response = await fetch(`${API_BASE}/api/sources/${businessId}${path}`, { ...options, headers, credentials: 'include' });
    if (response.status === 401) onUnauthorized?.();
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error || 'Request failed');
    return json;
  }

  async function refresh() {
    try {
      const { documents: next } = await request();
      setDocuments(next);
      onDocuments?.(next);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { refresh(); }, [businessId, adminToken]);

  const busy = uploading > 0 || documents.some((doc) => BUSY.includes(doc.status));
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [busy, businessId, adminToken]);

  async function upload(items) {
    setError('');
    setUploading((n) => n + items.length);
    for (const item of items) {
      try {
        await request('', { method: 'POST', body: JSON.stringify(await item.read()) });
      } catch (err) {
        setError(`${item.name}: ${err.message}`);
      } finally {
        setUploading((n) => n - 1);
        refresh();
      }
    }
  }

  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    const tooLarge = files.filter((file) => file.size > MAX_BYTES);
    if (tooLarge.length) setError(`${tooLarge.map((file) => file.name).join(', ')}: files must be 18 MB or smaller.`);
    upload(files.filter((file) => file.size <= MAX_BYTES).map((file) => ({ name: file.name, read: () => readFile(file) })));
  }

  function submitPaste(event) {
    event.preventDefault();
    const text = pasted.trim();
    if (!text) return;
    upload([{ name: 'Pasted text', read: async () => ({ text }) }]);
    setPasted('');
    setShowPaste(false);
  }

  async function remove(doc) {
    setError('');
    try {
      await request(`/${doc.id}`, { method: 'DELETE' });
    } catch (err) {
      setError(`${doc.filename}: ${err.message}`);
    }
    refresh();
  }

  return (
    <div className={`doclib doclib--${tone}`}>
      <label
        className={`doclib-drop${dragging ? ' is-dragging' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
      >
        <input type="file" multiple accept={ACCEPT} onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        <strong>Drop files here or browse</strong>
        <span>PDF, DOCX, Markdown, TXT, CSV or JSON, up to 18 MB each</span>
      </label>

      {showPaste ? (
        <form className="doclib-paste" onSubmit={submitPaste}>
          <label htmlFor={`doclib-paste-${businessId}`}>Paste text</label>
          <textarea id={`doclib-paste-${businessId}`} rows="5" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Policies, notes, FAQs…" />
          <div className="doclib-paste-actions">
            <button type="submit" disabled={!pasted.trim()}>Add text</button>
            <button type="button" className="doclib-ghost" onClick={() => setShowPaste(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <button type="button" className="doclib-ghost doclib-paste-toggle" onClick={() => setShowPaste(true)}>Or paste text instead</button>
      )}

      {error && <p className="doclib-error" role="alert">{error}</p>}

      {documents.length > 0 && (
        <ul className="doclib-list" aria-live="polite">
          {documents.map((doc) => (
            <li key={doc.id}>
              <span className="doclib-name">
                <strong>{doc.filename}</strong>
                <small>{doc.source_type}{doc.status === 'ready' ? ` · ${doc.chunk_count} chunk${doc.chunk_count === 1 ? '' : 's'}` : ''}{doc.error ? ` · ${doc.error}` : ''}</small>
              </span>
              <span className={`doclib-status doclib-status--${doc.status}`}>{STATUS_LABEL[doc.status] || doc.status}</span>
              <button type="button" className="doclib-remove" onClick={() => remove(doc)} disabled={BUSY.includes(doc.status)} aria-label={`Remove ${doc.filename}`}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {uploading > 0 && <p className="doclib-note" role="status">Uploading {uploading} file{uploading === 1 ? '' : 's'}…</p>}
    </div>
  );
}
