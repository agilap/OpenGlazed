import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import confetti from 'canvas-confetti';
import DocumentLibrary from '../components/DocumentLibrary';

const API_BASE = import.meta.env.VITE_API_BASE || '';

export default function Onboarding() {
  const [name, setName] = useState('');
  const [status, setStatus] = useState('');
  const [copyLabel, setCopyLabel] = useState('Copy embed code');
  const [businessId, setBusinessId] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [adminToken, setAdminToken] = useState(() => localStorage.getItem('glazed_admin_token') || '');
  const [needToken, setNeedToken] = useState(false);
  const [tokenRejected, setTokenRejected] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const celebratedRef = useRef(false);
  const navigate = useNavigate();

  useEffect(() => {
    fetch(`${API_BASE}/api/auth/me`, { credentials: 'include' }).then((r) => setSignedIn(r.ok)).catch(() => {});
  }, []);

  const ready = documents.some((doc) => doc.status === 'ready');
  const settled = documents.length > 0 && documents.every((doc) => doc.status === 'ready' || doc.status === 'error');
  const embedSnippet = businessId ? `<script src="/widget.js" data-business-id="${businessId}"></script>` : '';

  useEffect(() => {
    if (!ready || celebratedRef.current) return;
    celebratedRef.current = true;
    confetti({ particleCount: 80, spread: 70, colors: ['#c0c1ff', '#8083ff', '#494bd6', '#ffffff'] });
  }, [ready]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(embedSnippet);
      setCopyLabel('Copied!');
      setTimeout(() => setCopyLabel('Copy embed code'), 2000);
    } catch (_error) {
      setCopyLabel('Copy embed code');
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setStatus('Creating…');
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/businesses`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}) },
        body: JSON.stringify({ name }),
      });
      if (response.status === 401) {
        setStatus('');
        setTokenRejected(Boolean(adminToken));
        setNeedToken(true);
        return;
      }
      const data = await response.json();
      if (!response.ok) {
        setStatus('');
        setError(data.error || 'Could not create the workspace.');
        return;
      }
      if (adminToken) localStorage.setItem('glazed_admin_token', adminToken);
      setStatus('');
      setBusinessId(data.businessId);
    } catch (err) {
      setStatus('');
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="ob2-page">
      <style>{`
        .ob2-page { min-height: 100vh; background: #fff; color: #121218; font-family: Inter, sans-serif; }
        .ob2-page a { color: inherit; text-decoration: none; }
        .ob2-page a:hover { color: #494bd6; }
        .ob2-dark a:hover, .ob2-card a, .ob2-card a:hover { color: #c0c1ff; }
        .ob2-note a { text-decoration: underline; }
        .ob2-page :is(a, button, input):focus-visible { outline: 3px solid #8083ff; outline-offset: 4px; }
        .ob2-page :is(section[id], article[id], div[id]) { scroll-margin-top: 24px; }
        .ob2-tick { position: relative; }
        .ob2-tick::before, .ob2-tick::after { content: ''; position: absolute; top: -5px; width: 0; height: 0; border-top: 5px solid transparent; border-bottom: 5px solid transparent; }
        .ob2-tick::before { left: 0; border-left: 5px solid #d3d3dc; }
        .ob2-tick::after { right: 0; border-right: 5px solid #d3d3dc; }
        .ob2-dark .ob2-tick::before { border-left-color: #3a3a46; }
        .ob2-dark .ob2-tick::after { border-right-color: #3a3a46; }
        .ob2-card { flex: 0 1 440px; min-width: 0; background: #121218; color: #f4f4f5; border-radius: 12px; padding: 32px; display: flex; flex-direction: column; }
        .ob2-form { gap: 8px; }
        .ob2-card h2 { margin: 0; font-size: 24px; font-weight: 500; letter-spacing: -.02em; }
        .ob2-form h2 { margin-bottom: 16px; }
        .ob2-meta { margin: 0; font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #a1a1aa; }
        .ob2-form > .ob2-meta:first-child { margin-bottom: 4px; }
        .ob2-card label { font-size: 13px; color: #a1a1aa; }
        .ob2-card input { width: 100%; min-width: 0; height: 46px; margin-bottom: 12px; padding: 0 14px; background: #1b1b22; color: #f4f4f5; border: 1px solid #33333e; border-radius: 6px; font: inherit; font-size: 14px; }
        .ob2-card input::placeholder { color: #8a8a96; }
        .ob2-card input.ob2-url { margin-bottom: 16px; font-family: 'JetBrains Mono', monospace; font-size: 13px; }
        .ob2-card input[aria-invalid="true"] { border-color: #f87171; margin-bottom: 0; }
        .ob2-card button { font-family: inherit; cursor: pointer; border-radius: 6px; }
        .ob2-submit, .ob2-secondary { min-height: 46px; padding: 10px 14px; font-size: 14px; font-weight: 600; }
        .ob2-submit { border: 0; background: #f4f4f5; color: #121218; }
        .ob2-submit:hover { background: #dcdce7; }
        .ob2-submit:disabled { opacity: .6; cursor: wait; }
        .ob2-note { margin: 8px 0 0; font-size: 12px; line-height: 1.5; color: #a1a1aa; }
        .ob2-error { margin: 0 0 12px; color: #f87171; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
        .ob2-progress { gap: 12px; }
        .ob2-progress h2 { font-size: 22px; }
        .ob2-status { display: flex; align-items: center; gap: 8px; }
        .ob2-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
        .ob2-progress-track { height: 4px; background: #2a2a33; border-radius: 2px; overflow: hidden; margin-top: 8px; }
        .ob2-secondary { margin-top: 8px; background: transparent; color: #f4f4f5; border: 1px solid #33333e; }
        .ob2-embed-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-top: 8px; font-size: 13px; color: #a1a1aa; }
        .ob2-copy { min-height: 44px; padding: 0 12px; background: transparent; color: #c0c1ff; border: 1px solid #33333e; font-size: 13px; }
        .ob2-code { margin: 0; padding: 14px; background: #1b1b22; border: 1px solid #33333e; border-radius: 6px; font-family: 'JetBrains Mono', monospace; font-size: 12px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
        .ob2-page .ob2-test { padding: 12px 0; text-align: center; font-size: 14px; color: #c0c1ff; }
        @media (max-width: 1040px) { .ob2-rail { display: none !important; } }
        @media (max-width: 600px) {
          .ob2-page header, .ob2-page section, .ob2-page article, .ob2-page footer > div { padding-left: 16px !important; padding-right: 16px !important; }
          .ob2-card { flex-basis: 100%; padding: 24px; }
          .ob2-page header { gap: 8px 16px !important; }
          .ob2-page header nav { gap: 4px 16px !important; }
        }
        @media (prefers-reduced-motion: reduce) { .ob2-trace * { transition: none !important; } }
      `}</style>
<div style={{"fontFamily": "Inter, sans-serif", "color": "#121218", "background": "#ffffff", "minWidth": "0"}}>

  <div style={{"maxWidth": "1440px", "margin": "0 auto", "borderLeft": "1px solid #e4e4ea", "borderRight": "1px solid #e4e4ea", "boxSizing": "border-box"}}>

    <header style={{"display": "flex", "flexWrap": "wrap", "alignItems": "center", "justifyContent": "space-between", "gap": "8px 24px", "padding": "12px 32px"}}>
      <a href="#start" style={{"fontWeight": "600", "fontSize": "18px", "letterSpacing": "-0.02em", "padding": "10px 0"}}>Glazed AI</a>
      <nav aria-label="Primary" style={{"display": "flex", "flexWrap": "wrap", "alignItems": "center", "gap": "4px 24px", "fontSize": "14px"}}>
        <a href="#features" style={{"padding": "13px 0"}}>Features</a>
        <a href="#self-host" style={{"padding": "13px 0"}}>Self-host</a>
        <a href="https://github.com/agilap/OpenGlazed" style={{"padding": "13px 0"}}>GitHub</a>
        <a href={signedIn ? '/account' : '/login'} style={{"display": "inline-flex", "alignItems": "center", "height": "36px", "padding": "0 14px", "border": "1px solid #d3d3dc", "borderRadius": "6px", "fontWeight": "600"}}>{signedIn ? 'My workspace' : 'Sign in'}</a>
      </nav>
    </header>

    <section className="ob2-tick" style={{"borderTop": "1px solid #e4e4ea", "padding": "72px 32px 64px", "display": "flex", "flexDirection": "column", "alignItems": "center"}}>
      <p style={{"margin": "0 0 28px", "display": "inline-flex", "alignItems": "center", "gap": "8px", "border": "1px solid #e4e4ea", "borderRadius": "6px", "padding": "6px 12px", "fontFamily": "'JetBrains Mono', monospace", "fontSize": "12px", "color": "#5c5c68"}}>
        <span aria-hidden="true" style={{"width": "6px", "height": "6px", "borderRadius": "50%", "background": "#34d399"}}></span>
        self-hosted <span aria-hidden="true">/</span> <span style={{"color": "#121218"}}>your data</span>
      </p>
      <h1 style={{"margin": "0", "textAlign": "center", "fontSize": "clamp(44px, 6vw, 80px)", "lineHeight": "1.04", "letterSpacing": "-0.045em", "fontWeight": "500"}}>
        Your documents' agent,<br /><span style={{"color": "#494bd6"}}>on your own stack</span>
      </h1>
      <p style={{"margin": "24px 0 28px", "maxWidth": "600px", "textAlign": "center", "fontSize": "18px", "lineHeight": "1.5", "color": "#5c5c68"}}>
        Upload your PDFs, Word files and notes. Get an assistant that answers from them, cites the page it used, and runs on your models and your Postgres.
      </p>
      <a href="#start" style={{"display": "inline-flex", "alignItems": "center", "height": "46px", "padding": "0 20px", "marginBottom": "40px", "background": "#121218", "color": "#fff", "borderRadius": "6px", "fontSize": "14px", "fontWeight": "600"}}>Upload documents</a>

      <div style={{"width": "100%"}}>
        <RetrievalTrace />
      </div>
    </section>

    <section id="start" className="ob2-tick" style={{"borderTop": "1px solid #e4e4ea", "padding": "72px 32px", "display": "flex", "flexWrap": "wrap", "alignItems": "center", "justifyContent": "center", "gap": "48px 96px"}}>
      <div style={{"flex": "1 1 320px", "maxWidth": "440px"}}>
        <p style={{"margin": "0 0 16px", "fontFamily": "'JetBrains Mono', monospace", "fontSize": "11px", "letterSpacing": "0.08em", "color": "#5c5c68"}}>GET STARTED</p>
        <h2 style={{"margin": "0 0 16px", "fontSize": "clamp(32px, 4vw, 44px)", "fontWeight": "500", "letterSpacing": "-0.035em", "lineHeight": "1.1"}}>Fill the layers with your content</h2>
        <p style={{"margin": "0", "fontSize": "16px", "lineHeight": "1.55", "color": "#5c5c68"}}>Name a workspace and drop in your documents. Each file is parsed, chunked and embedded, and you can watch every one finish here.</p>
      </div>

        {!businessId ? (
          <form className="ob2-card ob2-form" onSubmit={handleSubmit}>
            <p className="ob2-meta">// new workspace</p>
            <h2>Name your workspace</h2>
            <label htmlFor="business-name">Workspace name</label>
            <input id="business-name" placeholder="Acme policies" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
            {needToken && (
              <>
                <label htmlFor="admin-token">ADMIN_TOKEN</label>
                <input id="admin-token" className="ob2-url" type="password" autoComplete="off" value={adminToken}
                  onChange={(e) => { setAdminToken(e.target.value.trim()); setTokenRejected(false); }}
                  aria-invalid={tokenRejected} aria-describedby="admin-token-note" required />
                <p id="admin-token-note" className="ob2-note" style={{ margin: '0 0 16px' }}><a href="/login">Sign in</a> or <a href="/signup">create an account</a> to create a workspace. Admins can paste the ADMIN_TOKEN from backend/.env instead.</p>
                {tokenRejected && <p className="ob2-error" role="alert">That token was rejected.</p>}
              </>
            )}
            <button className="ob2-submit" type="submit" disabled={loading}>{loading ? 'Creating…' : 'Continue'}</button>
            <p className="ob2-note">Next you'll add the documents your assistant answers from.</p>
            {status && <p className="ob2-meta" role="status">{status}</p>}
            {error && <p className="ob2-error" role="alert">{error}</p>}
          </form>
        ) : (
          <div className="ob2-card ob2-progress">
            <p className="ob2-meta ob2-status"><span className="ob2-dot" aria-hidden="true" style={{ background: ready ? '#34d399' : documents.length ? '#fbbf24' : '#8a8a96' }} />{name} / {ready ? (settled ? 'ready' : 'indexing') : documents.length ? 'indexing' : 'empty'}</p>
            <h2>{ready && settled ? 'Your documents are ready' : 'Add your documents'}</h2>
            <DocumentLibrary businessId={businessId} adminToken={adminToken} tone="dark" onDocuments={setDocuments} onUnauthorized={() => setNeedToken(true)} />
            {ready && <>
              <div className="ob2-embed-row"><span>Embed snippet</span><button className="ob2-copy" type="button" onClick={handleCopy}>{copyLabel}</button></div>
              <pre className="ob2-code">{embedSnippet}</pre>
              <button className="ob2-submit" type="button" onClick={() => navigate(`/dashboard/${businessId}`)}>Open dashboard</button>
              <a className="ob2-test" href={`/embed/${businessId}`} target="_blank" rel="noopener noreferrer">Ask your documents →</a>
            </>}
          </div>
        )}
    </section>

    <section className="ob2-tick" style={{"borderTop": "1px solid #e4e4ea", "padding": "36px 32px", "display": "flex", "flexDirection": "column", "alignItems": "center", "gap": "20px"}}>
      <p style={{"margin": "0", "fontSize": "15px"}}>Works with any OpenAI-compatible API</p>
      <ul style={{"listStyle": "none", "margin": "0", "padding": "0", "display": "flex", "flexWrap": "wrap", "justifyContent": "center", "gap": "8px 40px", "fontFamily": "'JetBrains Mono', monospace", "fontSize": "14px", "color": "#5c5c68"}}>
        <li>OpenAI</li><li>OpenRouter</li><li>Groq</li><li>Gemini</li><li>Anthropic</li><li>vLLM</li><li>Ollama</li>
      </ul>
    </section>
  </div>

  <div className="ob2-dark" id="features" style={{"background": "#0e0e12", "color": "#f4f4f5"}}>
    <div style={{"maxWidth": "1440px", "margin": "0 auto", "borderLeft": "1px solid #2a2a33", "borderRight": "1px solid #2a2a33", "boxSizing": "border-box"}}>
      <p style={{"margin": "0", "padding": "18px 32px", "fontFamily": "'JetBrains Mono', monospace", "fontSize": "12px", "color": "#f4f4f5"}}>features</p>

      <section className="ob2-tick" style={{"borderTop": "1px solid #2a2a33", "padding": "72px 32px"}}>
        <h2 style={{"margin": "0 0 20px", "fontSize": "clamp(36px, 4vw, 52px)", "fontWeight": "500", "letterSpacing": "-0.035em", "lineHeight": "1.1"}}>One agent, two surfaces</h2>
        <p style={{"margin": "0", "maxWidth": "480px", "fontSize": "18px", "lineHeight": "1.5", "color": "#a1a1aa"}}>A shareable chat for anyone who needs answers, and an internal team chat for staff. Both remember conversations across reloads.</p>
      </section>

      <div className="ob2-tick" style={{"borderTop": "1px solid #2a2a33", "display": "flex", "flexWrap": "wrap"}}>
        <nav className="ob2-rail" aria-label="Features" style={{"flex": "1 1 200px", "boxSizing": "border-box", "padding": "28px 32px", "borderRight": "1px solid #2a2a33", "display": "flex", "flexDirection": "column", "gap": "6px", "fontSize": "14px", "color": "#a1a1aa"}}>
          <a href="#retrieval" style={{"padding": "8px 0", "color": "#f4f4f5"}}>Retrieval</a>
          <a href="#agent" style={{"padding": "8px 0"}}>Agent</a>
          <a href="#widget" style={{"padding": "8px 0"}}>Widget</a>
          <a href="#team" style={{"padding": "8px 0"}}>Team chat</a>
          <a href="#self-host" style={{"padding": "8px 0"}}>Self-host</a>
        </nav>

        <div style={{"flex": "999 1 560px", "minWidth": "0"}}>

          <article id="retrieval" style={{"display": "grid", "gridTemplateColumns": "repeat(auto-fit, minmax(min(100%, 380px), 1fr))", "gap": "32px", "padding": "40px 32px"}}>
            <div>
              <p style={{"margin": "0 0 16px", "fontFamily": "'JetBrains Mono', monospace", "fontSize": "11px", "letterSpacing": "0.08em", "color": "#8a8a96"}}>RETRIEVAL</p>
              <h3 style={{"margin": "0 0 16px", "maxWidth": "380px", "fontSize": "28px", "fontWeight": "500", "letterSpacing": "-0.02em", "lineHeight": "1.2"}}>Hybrid retrieval, not a vector lookup</h3>
              <p style={{"margin": "0", "maxWidth": "400px", "fontSize": "15px", "lineHeight": "1.55", "color": "#a1a1aa"}}>Dense and lexical search fused with Reciprocal Rank Fusion, a RAPTOR summary layer, and a local cosine rerank. All on by default, no extra services.</p>
            </div>
            <div style={{"background": "#15151b", "border": "1px solid #2a2a33", "borderRadius": "8px", "padding": "24px", "fontFamily": "'JetBrains Mono', monospace", "fontSize": "13px", "lineHeight": "2", "overflowX": "auto"}}>
              <div style={{"display": "grid", "gridTemplateColumns": "90px 1fr"}}><span style={{"color": "#c0c1ff"}}>dense</span><span style={{"color": "#a1a1aa"}}>pgvector</span></div>
              <div style={{"display": "grid", "gridTemplateColumns": "90px 1fr"}}><span style={{"color": "#c0c1ff"}}>bm25</span><span style={{"color": "#a1a1aa"}}>postgres fts</span></div>
              <div style={{"display": "grid", "gridTemplateColumns": "90px 1fr"}}><span style={{"color": "#c0c1ff"}}>fuse</span><span style={{"color": "#a1a1aa"}}>rrf k=60</span></div>
              <div style={{"display": "grid", "gridTemplateColumns": "90px 1fr"}}><span style={{"color": "#c0c1ff"}}>raptor</span><span style={{"color": "#a1a1aa"}}>summary layer</span></div>
              <div style={{"display": "grid", "gridTemplateColumns": "90px 1fr"}}><span style={{"color": "#c0c1ff"}}>rerank</span><span style={{"color": "#a1a1aa"}}>local cosine</span></div>
            </div>
          </article>

          <article id="agent" style={{"borderTop": "1px solid #2a2a33", "display": "grid", "gridTemplateColumns": "repeat(auto-fit, minmax(min(100%, 380px), 1fr))", "gap": "32px", "padding": "40px 32px"}}>
            <div>
              <p style={{"margin": "0 0 16px", "fontFamily": "'JetBrains Mono', monospace", "fontSize": "11px", "letterSpacing": "0.08em", "color": "#8a8a96"}}>AGENT</p>
              <h3 style={{"margin": "0 0 16px", "maxWidth": "380px", "fontSize": "28px", "fontWeight": "500", "letterSpacing": "-0.02em", "lineHeight": "1.2"}}>It decides when to search, capture or escalate</h3>
              <p style={{"margin": "0", "maxWidth": "400px", "fontSize": "15px", "lineHeight": "1.55", "color": "#a1a1aa"}}>A small tool-calling loop with no framework. Falls back to plain RAG on providers without tool calling.</p>
            </div>
            <div style={{"background": "#15151b", "border": "1px solid #2a2a33", "borderRadius": "8px", "padding": "24px", "fontFamily": "'JetBrains Mono', monospace", "fontSize": "13px", "lineHeight": "2", "overflowX": "auto"}}>
              <div style={{"color": "#8a8a96"}}>// widget</div>
              <div style={{"color": "#f4f4f5"}}>search_knowledge</div>
              <div style={{"color": "#f4f4f5"}}>capture_lead</div>
              <div style={{"color": "#f4f4f5"}}>escalate</div>
              <div style={{"color": "#8a8a96", "marginTop": "12px"}}>// team</div>
              <div style={{"color": "#f4f4f5"}}>search_knowledge</div>
              <div style={{"color": "#f4f4f5"}}>recent_conversations</div>
              <div style={{"color": "#f4f4f5"}}>recent_leads</div>
            </div>
          </article>

          <article id="widget" style={{"borderTop": "1px solid #2a2a33", "display": "grid", "gridTemplateColumns": "repeat(auto-fit, minmax(min(100%, 380px), 1fr))", "gap": "32px", "padding": "40px 32px"}}>
            <div>
              <p style={{"margin": "0 0 16px", "fontFamily": "'JetBrains Mono', monospace", "fontSize": "11px", "letterSpacing": "0.08em", "color": "#8a8a96"}}>WIDGET</p>
              <h3 style={{"margin": "0 0 16px", "maxWidth": "380px", "fontSize": "28px", "fontWeight": "500", "letterSpacing": "-0.02em", "lineHeight": "1.2"}}>Share it with one script tag</h3>
              <p style={{"margin": "0", "maxWidth": "400px", "fontSize": "15px", "lineHeight": "1.55", "color": "#a1a1aa"}}>The widget shows the sources it used, so every answer can be checked. A visitor's chat comes back on reload.</p>
            </div>
            <div style={{"background": "#15151b", "border": "1px solid #2a2a33", "borderRadius": "8px", "padding": "24px", "fontFamily": "'JetBrains Mono', monospace", "fontSize": "13px", "lineHeight": "1.7", "overflowX": "auto"}}>
              <div style={{"color": "#8a8a96", "marginBottom": "8px"}}>// paste before &lt;/body&gt;</div>
              <code style={{"color": "#f4f4f5", "overflowWrap": "anywhere"}}>&lt;script src=<span style={{"color": "#c0c1ff"}}>"/widget.js"</span> data-business-id=<span style={{"color": "#c0c1ff"}}>"[BUSINESS_ID]"</span>&gt;&lt;/script&gt;</code>
            </div>
          </article>

          <article id="team" style={{"borderTop": "1px solid #2a2a33", "display": "grid", "gridTemplateColumns": "repeat(auto-fit, minmax(min(100%, 380px), 1fr))", "gap": "32px", "padding": "40px 32px"}}>
            <div>
              <p style={{"margin": "0 0 16px", "fontFamily": "'JetBrains Mono', monospace", "fontSize": "11px", "letterSpacing": "0.08em", "color": "#8a8a96"}}>TEAM CHAT</p>
              <h3 style={{"margin": "0 0 16px", "maxWidth": "380px", "fontSize": "28px", "fontWeight": "500", "letterSpacing": "-0.02em", "lineHeight": "1.2"}}>Ask about the business and its customers</h3>
              <p style={{"margin": "0", "maxWidth": "400px", "fontSize": "15px", "lineHeight": "1.55", "color": "#a1a1aa"}}>Staff talk to the same agent, with access to recent conversations and leads from the widget.</p>
            </div>
            <div style={{"background": "#15151b", "border": "1px solid #2a2a33", "borderRadius": "8px", "padding": "24px", "display": "flex", "flexDirection": "column", "gap": "12px", "fontSize": "14px", "lineHeight": "1.5"}}>
              <div style={{"alignSelf": "flex-end", "maxWidth": "80%", "background": "#2a2a33", "borderRadius": "8px", "padding": "10px 14px"}}>Which leads came in from the widget?</div>
              <div style={{"fontFamily": "'JetBrains Mono', monospace", "fontSize": "12px", "color": "#8a8a96"}}>→ recent_leads</div>
              <div style={{"alignSelf": "flex-start", "maxWidth": "80%", "color": "#a1a1aa"}}>[Answer listing recent leads]</div>
            </div>
          </article>

          <article id="self-host" style={{"borderTop": "1px solid #2a2a33", "display": "grid", "gridTemplateColumns": "repeat(auto-fit, minmax(min(100%, 380px), 1fr))", "gap": "32px", "padding": "40px 32px"}}>
            <div>
              <p style={{"margin": "0 0 16px", "fontFamily": "'JetBrains Mono', monospace", "fontSize": "11px", "letterSpacing": "0.08em", "color": "#8a8a96"}}>SELF-HOST</p>
              <h3 style={{"margin": "0 0 16px", "maxWidth": "380px", "fontSize": "28px", "fontWeight": "500", "letterSpacing": "-0.02em", "lineHeight": "1.2"}}>Three env vars pick the model</h3>
              <p style={{"margin": "0", "maxWidth": "400px", "fontSize": "15px", "lineHeight": "1.55", "color": "#a1a1aa"}}>Data and conversations stay in your own Postgres and pgvector, running locally through Docker. No cloud account needed.</p>
            </div>
            <div style={{"background": "#15151b", "border": "1px solid #2a2a33", "borderRadius": "8px", "padding": "24px", "fontFamily": "'JetBrains Mono', monospace", "fontSize": "13px", "lineHeight": "2", "overflowX": "auto", "whiteSpace": "nowrap"}}>
              <div><span style={{"color": "#8a8a96"}}>$</span> npm install</div>
              <div><span style={{"color": "#8a8a96"}}>$</span> docker compose up -d</div>
              <div><span style={{"color": "#8a8a96"}}>$</span> cp backend/.env.example backend/.env</div>
              <div style={{"color": "#c0c1ff"}}>LLM_BASE_URL / LLM_API_KEY / LLM_MODEL</div>
              <div><span style={{"color": "#8a8a96"}}>$</span> npm run dev</div>
            </div>
          </article>
        </div>
      </div>
    </div>
  </div>

  <div style={{"maxWidth": "1440px", "margin": "0 auto", "borderLeft": "1px solid #e4e4ea", "borderRight": "1px solid #e4e4ea", "boxSizing": "border-box"}}>
    <section style={{"padding": "96px 32px", "display": "flex", "flexDirection": "column", "alignItems": "center", "textAlign": "center"}}>
      <h2 style={{"margin": "0 0 20px", "maxWidth": "800px", "fontSize": "clamp(32px, 4vw, 52px)", "fontWeight": "500", "letterSpacing": "-0.035em", "lineHeight": "1.1"}}>Own the assistant, the models and the data</h2>
      <p style={{"margin": "0 0 32px", "maxWidth": "520px", "fontSize": "18px", "lineHeight": "1.5", "color": "#5c5c68"}}>No API-key lock-in, and no third party between you and your customers.</p>
      <div style={{"display": "flex", "flexWrap": "wrap", "justifyContent": "center", "gap": "12px"}}>
        <a href="#start" style={{"display": "inline-flex", "alignItems": "center", "height": "46px", "padding": "0 20px", "background": "#121218", "color": "#fff", "borderRadius": "6px", "fontSize": "14px", "fontWeight": "600"}}>Upload documents</a>
        <a href="https://github.com/agilap/OpenGlazed" style={{"display": "inline-flex", "alignItems": "center", "height": "46px", "padding": "0 20px", "border": "1px solid #d3d3dc", "borderRadius": "6px", "fontSize": "14px", "fontWeight": "600"}}>View on GitHub</a>
      </div>
    </section>
  </div>

  <footer className="ob2-dark" style={{"background": "#0e0e12", "color": "#a1a1aa"}}>
    <div style={{"maxWidth": "1440px", "margin": "0 auto", "borderLeft": "1px solid #2a2a33", "borderRight": "1px solid #2a2a33", "boxSizing": "border-box", "padding": "48px 32px 32px"}}>
      <div style={{"display": "flex", "flexWrap": "wrap", "justifyContent": "space-between", "gap": "32px"}}>
        <div style={{"fontSize": "18px", "fontWeight": "600", "letterSpacing": "-0.02em", "color": "#f4f4f5"}}>Glazed AI</div>
        <div style={{"display": "flex", "flexWrap": "wrap", "gap": "32px 72px", "fontSize": "14px"}}>
          <div style={{"display": "flex", "flexDirection": "column", "gap": "4px"}}>
            <p style={{"margin": "0 0 8px", "fontFamily": "'JetBrains Mono', monospace", "fontSize": "11px", "letterSpacing": "0.08em", "color": "#8a8a96"}}>PRODUCT</p>
            <a href="#features" style={{"padding": "6px 0"}}>Features</a>
            <a href="#self-host" style={{"padding": "6px 0"}}>Self-host</a>
            <a href="#start" style={{"padding": "6px 0"}}>Get started</a>
          </div>
          <div style={{"display": "flex", "flexDirection": "column", "gap": "4px"}}>
            <p style={{"margin": "0 0 8px", "fontFamily": "'JetBrains Mono', monospace", "fontSize": "11px", "letterSpacing": "0.08em", "color": "#8a8a96"}}>PROJECT</p>
            <a href="https://github.com/agilap/OpenGlazed" style={{"padding": "6px 0"}}>GitHub</a>
            <a href="https://github.com/agilap/OpenGlazed#readme" style={{"padding": "6px 0"}}>README</a>
            <a href="https://github.com/agilap/OpenGlazed/blob/main/LICENSE" style={{"padding": "6px 0"}}>MIT License</a>
          </div>
        </div>
      </div>
      <p style={{"margin": "40px 0 0", "fontSize": "13px", "color": "#8a8a96"}}>© 2026 Alexander Penuliar</p>
    </div>
  </footer>
</div>
    </main>
  );
}

function RetrievalTrace() {
  const [tick, setTick] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 6 : 0);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer;
    function syncMotion() {
      clearInterval(timer);
      if (motion.matches) setTick(6);
      else {
        setTick(0);
        timer = setInterval(() => setTick((value) => (value + 1) % 7), 1400);
      }
    }
    syncMotion();
    motion.addEventListener('change', syncMotion);
    return () => { clearInterval(timer); motion.removeEventListener('change', syncMotion); };
  }, []);
  const step = Math.min(tick, 4);
  const sizes = [48, 24, 12, 5];
  const columns = [
    { name: 'CHUNKS + RAPTOR', detail: 'your documents and their summaries' },
    { name: 'DENSE + BM25', detail: 'pgvector + postgres fts' },
    { name: 'RRF', detail: 'rank fusion, k=60' },
    { name: 'RERANK', detail: 'local cosine, top 5' },
  ].map((col, k) => {
    const size = sizes[k];
    const keep = k < 3 ? sizes[k + 1] : size;
    const squares = Array.from({ length: size }, (_, i) => {
      const survives = (i * 7) % size < keep;
      let bg = '#2a2a33';
      if (step === k) bg = '#8083ff';
      else if (step > k && survives) bg = '#c0c1ff';
      return { bg };
    });
    return { ...col, squares, rule: step >= k ? '#8083ff' : '#2a2a33', label: step === k ? '#c0c1ff' : '#a1a1aa' };
  });
  const answered = step === 4;
  const agentRule = answered ? '#8083ff' : '#2a2a33';
  const agentLabel = answered ? '#c0c1ff' : '#a1a1aa';
  return (
<div className="ob2-trace" style={{"boxSizing": "border-box", "width": "100%", "maxWidth": "1180px", "margin": "0 auto", "background": "#121218", "color": "#f4f4f5", "border": "1px solid #2a2a33", "borderRadius": "12px", "fontFamily": "'JetBrains Mono', monospace", "textAlign": "left"}}>
  <div style={{"display": "flex", "flexWrap": "wrap", "alignItems": "center", "justifyContent": "space-between", "gap": "8px 24px", "padding": "16px 24px", "borderBottom": "1px solid #2a2a33", "fontSize": "13px"}}>
    <span><span style={{"color": "#8a8a96"}}>query&gt;</span> How many days do customers have to request a refund?</span>
    <span style={{"fontSize": "12px", "color": "#8a8a96"}}>example trace, acme policies</span>
  </div>

  <div style={{"display": "flex", "flexWrap": "wrap", "gap": "24px", "padding": "24px"}}>
    {columns.map((col) => (
      <div key={col.name} style={{"flex": "1 1 160px", "minWidth": "0", "borderTop": `2px solid ${col.rule}`, "paddingTop": "12px", "transition": "border-color 400ms"}}>
        <p style={{"margin": "0 0 4px", "fontSize": "11px", "letterSpacing": "0.08em", "color": col.label, "transition": "color 400ms"}}>{col.name}</p>
        <p style={{"margin": "0 0 16px", "minHeight": "32px", "fontSize": "12px", "lineHeight": "16px", "color": "#8a8a96"}}>{col.detail}</p>
        <div aria-hidden="true" style={{"display": "flex", "flexWrap": "wrap", "gap": "4px"}}>
          {col.squares.map((sq, i) => (
            <span key={i} style={{"width": "12px", "height": "12px", "borderRadius": "2px", "background": sq.bg, "transition": "background 400ms"}}></span>
          ))}
        </div>
      </div>
    ))}

    <div style={{"flex": "1.7 1 280px", "minWidth": "0", "borderTop": `2px solid ${agentRule}`, "paddingTop": "12px", "transition": "border-color 400ms"}}>
      <p style={{"margin": "0 0 4px", "fontSize": "11px", "letterSpacing": "0.08em", "color": agentLabel, "transition": "color 400ms"}}>AGENT</p>
      <p style={{"margin": "0 0 16px", "minHeight": "32px", "fontSize": "12px", "lineHeight": "16px", "color": "#8a8a96"}}>answers from what it found, with sources</p>
      {answered && (<>
        <p style={{"margin": "0 0 12px", "fontFamily": "Inter, sans-serif", "fontSize": "15px", "lineHeight": "1.5"}}>Customers can request a refund within 30 days of purchase, with the original receipt.</p>
        <div style={{"display": "flex", "flexWrap": "wrap", "gap": "6px", "fontSize": "12px", "color": "#c0c1ff"}}>
          <span style={{"border": "1px solid #33333e", "borderRadius": "4px", "padding": "3px 7px"}}>refund-policy.pdf p.2</span>
          <span style={{"border": "1px solid #33333e", "borderRadius": "4px", "padding": "3px 7px"}}>support-handbook.docx</span>
        </div>
      </>)}
      {!answered && (<>
        <p style={{"margin": "0", "fontSize": "12px", "color": "#8a8a96"}}>searching...</p>
      </>)}
    </div>
  </div>
</div>
  );
}
