import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';

const API_BASE = import.meta.env.VITE_API_BASE || '';

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function normalizePriority(value) {
  return (value || '').toLowerCase();
}

export default function Dashboard() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [stats, setStats] = useState({
    totalLeads: 0,
    totalConversations: 0,
    escalationRate: 0,
  });
  const [ingestStatus, setIngestStatus] = useState({ status: '', ingest_progress: 0 });
  const [leads, setLeads] = useState([]);
  const [selectedLead, setSelectedLead] = useState(null);
  const [transcript, setTranscript] = useState([]);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reingesting, setReingesting] = useState(false);
  const [error, setError] = useState(null);
  const [adminToken, setAdminToken] = useState(() => localStorage.getItem('glazed_admin_token') || '');
  const [needToken, setNeedToken] = useState(false);

  const saveToken = (value) => {
    setAdminToken(value);
    if (value) localStorage.setItem('glazed_admin_token', value);
    else localStorage.removeItem('glazed_admin_token');
  };

  async function authedFetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (adminToken) headers['Authorization'] = `Bearer ${adminToken}`;
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) setNeedToken(true);
    return response;
  }

  const businessId = id;
  const progressValue = Math.max(0, Math.min(100, Number(ingestStatus.ingest_progress) || 0));
  const embedSnippet = useMemo(
    () => `<script src="/widget.js" data-business-id="${businessId}"></script>`,
    [businessId]
  );

  async function fetchDashboard() {
    const response = await authedFetch(`${API_BASE}/api/businesses/${businessId}/dashboard`);
    const json = await response.json();
    if (!response.ok || json.error) {
      throw new Error(json.error || 'Failed to load dashboard');
    }
    setData(json);
  }

  async function fetchStats() {
    const response = await authedFetch(`${API_BASE}/api/dashboard/${businessId}/stats`);
    const json = await response.json();
    if (!response.ok || json.error) {
      throw new Error(json.error || 'Failed to load stats');
    }
    setStats({
      totalLeads: json.totalLeads || 0,
      totalConversations: json.totalConversations || 0,
      escalationRate: Math.round((json.escalationRate || 0) * 100) / 100,
    });
  }

  async function fetchIngestStatus() {
    const response = await fetch(`${API_BASE}/api/ingest/${businessId}/status`);
    const json = await response.json();
    if (!response.ok || json.error) {
      throw new Error(json.error || 'Failed to load ingest status');
    }
    setIngestStatus({
      status: json.status || '',
      ingest_progress: Number(json.ingest_progress) || 0,
    });
  }

  async function fetchLeads() {
    let response = await authedFetch(`${API_BASE}/api/leads/${businessId}`);

    if (!response.ok) {
      response = await authedFetch(`${API_BASE}/api/dashboard/${businessId}/leads`);
    }

    const json = await response.json();
    if (!response.ok || json.error) {
      throw new Error(json.error || 'Failed to load leads');
    }

    setLeads(Array.isArray(json) ? json : []);
  }

  useEffect(() => {
    if (!businessId) return;

    let active = true;

    async function load() {
      try {
        const results = await Promise.all([
          fetchDashboard(),
          fetchStats(),
          fetchIngestStatus(),
          fetchLeads(),
        ]);
        if (!active) return;
        return results;
      } catch (err) {
        if (!active) return;
        setError(err.message);
      }
    }

    load();

    return () => {
      active = false;
    };
  }, [businessId]);

  useEffect(() => {
    if (!businessId) return undefined;

    const id = setInterval(() => {
      fetchIngestStatus().catch(() => {});
    }, 5000);

    return () => clearInterval(id);
  }, [businessId]);

  useEffect(() => {
    if (adminToken && businessId) {
      reload();
    }
  }, [adminToken]);

  async function openTranscript(lead) {
    setSelectedLead(lead);
    setTranscript([]);
    setTranscriptLoading(true);

    try {
      const response = await authedFetch(
        `${API_BASE}/api/dashboard/${businessId}/transcripts?sessionId=${encodeURIComponent(lead.session_id || '')}`
      );
      const json = await response.json();
      if (!response.ok || json.error) {
        throw new Error(json.error || 'Failed to load transcript');
      }
      setTranscript(Array.isArray(json) ? json : []);
    } catch (_error) {
      setTranscript([]);
    } finally {
      setTranscriptLoading(false);
    }
  }

  async function copyEmbedCode() {
    try {
      await navigator.clipboard.writeText(embedSnippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_error) {
      setCopied(false);
    }
  }

  async function triggerReingest() {
    if (!data?.business?.url) return;

    const confirmed = window.confirm('Re-ingest this website now?');
    if (!confirmed) return;

    setReingesting(true);

    try {
      let response = await authedFetch(`${API_BASE}/api/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId, url: data.business.url }),
      });

      if (!response.ok) {
        response = await authedFetch(`${API_BASE}/api/ingest/${businessId}`, { method: 'POST' });
      }

      const json = await response.json();
      if (!response.ok || json.error) {
        throw new Error(json.error || 'Failed to trigger ingest');
      }

      await fetchIngestStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setReingesting(false);
    }
  }

  async function reload() {
    setError(null);
    setNeedToken(false);
    try {
      await Promise.all([fetchDashboard(), fetchStats(), fetchIngestStatus(), fetchLeads()]);
    } catch (err) {
      setError(err.message);
    }
  }

  if (error) {
    return (
      <main className="dashboard-loading">
        <p>{error}</p>
        <Link to="/">Back to onboarding</Link>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="dashboard-loading">
        <p>Loading dashboard...</p>
      </main>
    );
  }

  const businessName = data.business?.name || 'Business';
  const statusTone = ingestStatus.status === 'active' ? 'ok' : ingestStatus.status === 'error' ? 'err' : 'ing';

  function getPriorityClass(priority) {
    if (priority === 'high') return 'priority-high';
    if (priority === 'medium') return 'priority-medium';
    return 'priority-low';
  }

  return (
    <div className="dashboard-shell">
      <aside className="dashboard-sidebar">
        <div>
          <div className="dashboard-wordmark">Glazed</div>
          <nav className="dashboard-nav">
            <button className="dashboard-nav-item dashboard-nav-item--active" type="button"><span>◉</span><span>Overview</span></button>
            <button className="dashboard-nav-item" type="button"><span>◎</span><span>Leads</span></button>
            <button className="dashboard-nav-item" type="button"><span>◌</span><span>Transcripts</span></button>
            <button className="dashboard-nav-item" type="button"><span>◍</span><span>Embed</span></button>
          </nav>
        </div>

        <div className="dashboard-sidebar-footer">
          <strong>{businessName}</strong>
          <span className={`dashboard-status-pill dashboard-status-pill--${statusTone}`}>
            {ingestStatus.status || 'idle'}
          </span>
          <Link to="/" className="dashboard-back-link">← Back to onboarding</Link>
        </div>
      </aside>

      <main className="dashboard-main">
        <header className="dashboard-header">
          <div>
            <h1>{businessName} Dashboard</h1>
            <p>{data.business.url}</p>
          </div>
          <div className="dashboard-actions">
            <button className="dashboard-action" type="button" onClick={copyEmbedCode}>{copied ? 'Copied!' : 'Copy Embed Code'}</button>
            <button className="dashboard-action-primary" type="button" onClick={triggerReingest} disabled={reingesting}>
              {reingesting ? 'Re-ingesting...' : 'Re-ingest'}
            </button>
          </div>
        </header>

        {(!adminToken || needToken) && (
          <section className="dashboard-token-banner">
            <span>This dashboard is protected. Paste your ADMIN_TOKEN:</span>
            <input
              type="password"
              value={adminToken}
              placeholder="ADMIN_TOKEN"
              onChange={(e) => { saveToken(e.target.value); setNeedToken(false); }}
              className="dashboard-token-input"
            />
            <button type="button" className="dashboard-action" onClick={() => reload()}>Load</button>
          </section>
        )}

        <section className="dashboard-stats-grid">
          <article className="dashboard-stat-card">
            <span className="dashboard-stat-label">Total Leads</span>
            <strong className="dashboard-stat-value">{stats.totalLeads}</strong>
            <span className={`dashboard-trend ${stats.totalLeads > 0 ? 'up' : 'down'}`}>
              {stats.totalLeads > 0 ? '↗' : '↘'} {stats.totalLeads > 0 ? 'Growing' : 'No activity yet'}
            </span>
          </article>
          <article className="dashboard-stat-card">
            <span className="dashboard-stat-label">Conversations</span>
            <strong className="dashboard-stat-value">{stats.totalConversations}</strong>
            <span className={`dashboard-trend ${stats.totalConversations > 0 ? 'up' : 'down'}`}>
              {stats.totalConversations > 0 ? '↗' : '↘'} {stats.totalConversations > 0 ? 'Healthy volume' : 'Waiting for traffic'}
            </span>
          </article>
          <article className="dashboard-stat-card">
            <span className="dashboard-stat-label">Escalation Rate</span>
            <strong className="dashboard-stat-value">{stats.escalationRate}%</strong>
            <span className={`dashboard-trend ${stats.escalationRate < 30 ? 'up' : 'down'}`}>
              {stats.escalationRate < 30 ? '↗' : '↘'} {stats.escalationRate < 30 ? 'Within target' : 'Needs tuning'}
            </span>
          </article>
        </section>

        {ingestStatus.status === 'ingesting' && (
          <div className="dashboard-ingest-banner">
            <span>Ingesting knowledge base: {progressValue}%</span>
            <div className="dashboard-ingest-track">
              <div className="dashboard-ingest-fill" style={{ transform: `scaleX(${progressValue / 100})` }} />
            </div>
          </div>
        )}

        <section className="dashboard-table-card">
          <div className="dashboard-table-head" role="row">
            <span>Name</span>
            <span>Email</span>
            <span>Intent</span>
            <span>Sentiment</span>
            <span>Priority</span>
            <span>Date</span>
          </div>

          {leads.length === 0 ? <p className="dashboard-empty">No leads yet.</p> : null}

          {leads.map((lead) => {
            const priority = normalizePriority(lead.follow_up_priority);
            return (
              <button
                className="dashboard-row"
                key={lead.id || `${lead.email}-${lead.created_at}`}
                type="button"
                onClick={() => openTranscript(lead)}
              >
                <span className="dashboard-cell">{lead.name || '-'}</span>
                <span className="dashboard-cell">{lead.email || '-'}</span>
                <span className="dashboard-cell">{lead.intent || '-'}</span>
                <span className="dashboard-cell">{lead.sentiment || '-'}</span>
                <span className="dashboard-cell">
                  <span className={`priority-badge ${getPriorityClass(priority)}`}>
                    {lead.follow_up_priority || 'low'}
                  </span>
                </span>
                <span className="dashboard-cell">{formatDate(lead.created_at)}</span>
              </button>
            );
          })}

          <div className="dashboard-table-foot">{leads.length} total leads</div>
        </section>

        <section className="dashboard-embed-card">
          <h2>Embed Code</h2>
          <pre>{embedSnippet}</pre>
        </section>
      </main>

      <aside className={`transcript-panel ${selectedLead ? 'open' : ''}`}>
        <div className="transcript-header">
          <h3>Transcript</h3>
          <button type="button" onClick={() => setSelectedLead(null)}>Close</button>
        </div>

        {selectedLead && (
          <p className="transcript-session">Session: {selectedLead.session_id || 'unknown'}</p>
        )}

        {transcriptLoading ? (
          <p className="dashboard-empty">Loading transcript...</p>
        ) : transcript.length === 0 ? (
          <p className="dashboard-empty">No transcript available for this session.</p>
        ) : (
          <div className="transcript-messages">
            {transcript.map((message) => {
              const isVisitor = message.role === 'visitor';
              return (
                <div
                  key={message.id || `${message.role}-${message.created_at}-${message.content?.slice(0, 20)}`}
                  className={`transcript-bubble ${isVisitor ? 'visitor' : 'assistant'}`}
                >
                  <div>{message.content}</div>
                </div>
              );
            })}
          </div>
        )}
      </aside>
    </div>
  );
}
