import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import AdminTokenForm from '../components/AdminTokenForm';
import TracePanel from '../components/TracePanel';

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
  const [chats, setChats] = useState([]);
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
      escalationRate: Math.round((json.escalationRate || 0) * 100),
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
    const response = await authedFetch(`${API_BASE}/api/dashboard/${businessId}/leads`);
    const json = await response.json();
    if (!response.ok || json.error) {
      throw new Error(json.error || 'Failed to load leads');
    }

    setLeads(Array.isArray(json) ? json : []);
  }

  async function fetchChats() {
    const response = await authedFetch(`${API_BASE}/api/dashboard/${businessId}/sessions`);
    const json = await response.json();
    if (!response.ok || json.error) {
      throw new Error(json.error || 'Failed to load conversations');
    }
    setChats(Array.isArray(json) ? json : []);
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
          fetchChats(),
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
      const response = await authedFetch(`${API_BASE}/api/ingest/${businessId}`, { method: 'POST' });

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
      await Promise.all([fetchDashboard(), fetchStats(), fetchIngestStatus(), fetchLeads(), fetchChats()]);
    } catch (err) {
      setError(err.message);
    }
  }

  function submitToken(value) {
    if (value === adminToken) reload();
    else saveToken(value);
  }

  const tokenForm = (
    <AdminTokenForm
      id="dashboard-admin-token"
      label="This dashboard is protected. Paste your ADMIN_TOKEN."
      initialToken={adminToken}
      rejected={needToken && Boolean(adminToken)}
      onSubmit={submitToken}
    />
  );

  if (needToken && !data) {
    return <main className="dashboard-loading">{tokenForm}</main>;
  }

  if (error && !needToken) {
    return (
      <main className="dashboard-loading">
        <div className="dashboard-load-error">
          <p role="alert">{error}</p>
          <Link className="dashboard-action" to="/">Back to home</Link>
        </div>
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
          <div className="dashboard-wordmark">Glazed AI</div>
          <nav className="dashboard-nav" aria-label="Dashboard">
            <a className="dashboard-nav-item dashboard-nav-item--active" href="#overview">Overview</a>
            <a className="dashboard-nav-item" href="#leads">Leads</a>
            <a className="dashboard-nav-item" href="#conversations">Conversations</a>
            <a className="dashboard-nav-item" href="#traces">Traces</a>
            <a className="dashboard-nav-item" href="#embed">Embed</a>
            <Link className="dashboard-nav-item" to={`/team/${businessId}`}>Team chat</Link>
          </nav>
        </div>
        <div className="dashboard-sidebar-footer">
          <strong>{businessName}</strong>
          <span className={`dashboard-status-pill dashboard-status-pill--${statusTone}`}>
            <span className="dashboard-status-dot" aria-hidden="true" />
            ingest / {ingestStatus.status || 'idle'}
          </span>
          <Link to="/" className="dashboard-back-link">← Back to home</Link>
        </div>
      </aside>

      <main className="dashboard-main">
        <header className="dashboard-header" id="overview">
          <div>
            <h1>{businessName}</h1>
            <p>{data.business.url}</p>
          </div>
          <div className="dashboard-actions">
            <button className="dashboard-action" type="button" onClick={copyEmbedCode}>{copied ? 'Copied!' : 'Copy embed code'}</button>
            <button className="dashboard-action-primary" type="button" onClick={triggerReingest} disabled={reingesting}>
              {reingesting ? 'Re-ingesting...' : 'Re-ingest'}
            </button>
          </div>
        </header>

        {(!adminToken || needToken) && tokenForm}

        <section className="dashboard-stats-grid" aria-label="Stats">
          <article className="dashboard-stat-card">
            <span className="dashboard-stat-label">Leads</span>
            <strong className="dashboard-stat-value">{stats.totalLeads}</strong>
          </article>
          <article className="dashboard-stat-card">
            <span className="dashboard-stat-label">Conversations</span>
            <strong className="dashboard-stat-value">{stats.totalConversations}</strong>
          </article>
          <article className="dashboard-stat-card">
            <span className="dashboard-stat-label">Escalation rate</span>
            <strong className="dashboard-stat-value">{stats.escalationRate}%</strong>
          </article>
        </section>

        {ingestStatus.status === 'ingesting' && (
          <div className="dashboard-ingest-banner">
            <span className="dashboard-ingest-label"><span className="dashboard-status-dot" aria-hidden="true" />ingest / running, {progressValue}%</span>
            <div className="dashboard-ingest-track" role="progressbar" aria-label="Ingest progress" aria-valuenow={progressValue} aria-valuemin={0} aria-valuemax={100}>
              <div className="dashboard-ingest-fill" style={{ transform: `scaleX(${progressValue / 100})` }} />
            </div>
          </div>
        )}

        <section className="dashboard-table-card" id="leads" aria-labelledby="leads-heading">
          <div className="dashboard-section-heading">
            <h2 id="leads-heading">Leads</h2>
            <span>{leads.length} total</span>
          </div>
          <div className="dashboard-table-scroll">
            <table className="dashboard-table">
              <thead><tr>
                <th scope="col">Name</th><th scope="col">Email</th><th scope="col">Intent</th>
                <th scope="col">Sentiment</th><th scope="col">Priority</th><th scope="col">Date</th>
              </tr></thead>
              <tbody>
                {leads.map((lead) => {
                  const priority = normalizePriority(lead.follow_up_priority);
                  return (
                    <tr key={lead.id || `${lead.email}-${lead.created_at}`}>
                      <td><button className="dashboard-table-button" type="button" onClick={() => openTranscript(lead)}>{lead.name || '-'}</button></td>
                      <td>{lead.email || '-'}</td><td>{lead.intent || '-'}</td><td>{lead.sentiment || '-'}</td>
                      <td><span className={`dashboard-priority priority-${priority === 'high' || priority === 'medium' ? priority : 'low'}`}>{lead.follow_up_priority || 'low'}</span></td>
                      <td className="dashboard-date">{formatDate(lead.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {leads.length === 0 && (
            <div className="dashboard-empty-state"><h3>No leads yet</h3><p>Leads appear here when a visitor leaves their details in the widget.</p></div>
          )}
        </section>

        <section className="dashboard-table-card" id="conversations" aria-labelledby="conversations-heading">
          <div className="dashboard-section-heading">
            <h2 id="conversations-heading">Recent conversations</h2>
            <span>{chats.filter((chat) => chat.escalated).length} needs reply</span>
          </div>
          <div className="dashboard-table-scroll">
            <table className="dashboard-table">
              <thead><tr>
                <th scope="col">Conversation</th><th scope="col">Visitor</th><th scope="col">Messages</th><th scope="col">Last active</th>
              </tr></thead>
              <tbody>
                {chats.map((chat) => (
                  <tr key={chat.session_id}>
                    <td><button className="dashboard-table-button" type="button" onClick={() => openTranscript(chat)}>
                      {chat.escalated ? <span className="dashboard-needs-reply">needs reply</span> : null}
                      {chat.title || '(no message)'}
                    </button></td>
                    <td>{chat.lead_name || chat.lead_email || 'Anonymous'}</td>
                    <td>{chat.message_count}</td><td className="dashboard-date">{formatDate(chat.last_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {chats.length === 0 && (
            <div className="dashboard-empty-state"><h3>No conversations yet</h3><p>Paste the embed code on your site, or <Link to={`/embed/${businessId}`} target="_blank" rel="noopener noreferrer">test your chatbot</Link>.</p></div>
          )}
        </section>

        <TracePanel key={businessId} businessId={businessId} adminToken={adminToken} onUnauthorized={() => setNeedToken(true)} />

        <section className="dashboard-embed-card" id="embed">
          <h2>Embed code</h2>
          <pre>{embedSnippet}</pre>
        </section>
      </main>

      <aside className={`transcript-panel ${selectedLead ? 'open' : ''}`} aria-label="Transcript" inert={!selectedLead}>
        <div className="transcript-header">
          <h2>Transcript</h2>
          <button className="dashboard-action" type="button" onClick={() => setSelectedLead(null)}>Close</button>
        </div>
        {selectedLead && <p className="transcript-session">Session: {selectedLead.session_id || 'unknown'}</p>}
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
