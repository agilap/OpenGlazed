import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE || '';

export default function TracePanel({ businessId, adminToken, onUnauthorized }) {
  const [traces, setTraces] = useState([]);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [detailId, setDetailId] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setSelected(null);
    setDetailId(null);
    setTraces([]);
    fetch(`${API_BASE}/api/dashboard/${businessId}/traces?limit=25`, {
      headers: adminToken ? { Authorization: `Bearer ${adminToken}` } : {}, credentials: 'include', signal: controller.signal,
    }).then(async (response) => {
      if (response.status === 401) onUnauthorized();
      if (!response.ok) throw new Error('Could not load traces. Check your admin token and retry.');
      const rows = await response.json();
      if (!controller.signal.aborted) setTraces(Array.isArray(rows) ? rows : []);
    }).catch((err) => {
      if (!controller.signal.aborted) setError(err.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [businessId, adminToken, refresh]);

  useEffect(() => {
    if (!detailId) return;
    const controller = new AbortController();
    setSelected(null);
    fetch(`${API_BASE}/api/dashboard/${businessId}/traces/${encodeURIComponent(detailId)}`, {
      headers: adminToken ? { Authorization: `Bearer ${adminToken}` } : {}, credentials: 'include', signal: controller.signal,
    }).then(async (response) => {
      if (response.status === 401) onUnauthorized();
      if (!response.ok) throw new Error('Could not load trace details.');
      const detail = await response.json();
      if (!controller.signal.aborted) setSelected(detail);
    }).catch((err) => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [detailId, businessId, adminToken]);

  return (
    <section className="dashboard-table-card" id="traces" aria-labelledby="traces-heading">
      <div className="dashboard-section-heading">
        <h2 id="traces-heading">Request traces</h2>
        <button className="dashboard-action" disabled={loading} onClick={() => setRefresh((n) => n + 1)} type="button">{loading ? 'Loading…' : 'Refresh'}</button>
      </div>
      <p style={{ padding: '0 24px' }}>Private conversation data. Showing the latest 25 retained requests. Select a request to inspect retrieval scores, context, usage, latency, and errors.</p>
      {error && <p role="alert" style={{ padding: '0 24px' }}>{error}</p>}
      <div className="dashboard-table-scroll" aria-busy={loading}>
        <table className="dashboard-table">
          <thead><tr><th scope="col">Query</th><th scope="col">Source</th><th scope="col">Model</th><th scope="col">Time</th></tr></thead>
          <tbody>{traces.map((trace) => (
            <tr key={trace.id}>
              <td><button className="dashboard-table-button" type="button" aria-expanded={detailId === trace.id} onClick={() => { setError(''); setDetailId(detailId === trace.id ? null : trace.id); }}>{trace.query || '(empty query)'}</button></td>
              <td>{trace.source || '—'}</td><td>{trace.model || '—'}</td><td>{new Date(trace.created_at).toLocaleString()}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {!loading && !traces.length && <p className="dashboard-empty">No retained traces yet.</p>}
      {detailId && <div style={{ padding: 24 }}>
        <h3>Trace details</h3>
        <button className="dashboard-action" type="button" onClick={() => { setDetailId(null); setSelected(null); }}>Close details</button>
        <pre tabIndex={0} aria-label="Trace JSON" style={{ maxHeight: 480, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{selected ? JSON.stringify(selected, null, 2) : 'Loading details…'}</pre>
      </div>}
    </section>
  );
}
