import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import confetti from 'canvas-confetti';

const API_BASE = import.meta.env.VITE_API_BASE || '';

function validateBusinessUrl(value) {
  const trimmed = (value || '').trim();

  if (!/^https?:\/\//i.test(trimmed)) {
    return 'URL must start with http:// or https://';
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_error) {
    return 'Please enter a valid URL';
  }

  const host = (parsed.hostname || '').toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'Localhost URLs are not allowed';
  }

  if (/^(\d{1,3}\.){3}\d{1,3}/.test(host)) {
    return 'IP address URLs are not allowed';
  }

  return null;
}

function getProgressLabel(progress) {
  if (progress <= 10) return 'Scraping pages...';
  if (progress <= 25) return 'Chunking content...';
  if (progress <= 55) return 'Building knowledge tree...';
  if (progress <= 80) return 'Generating embeddings...';
  if (progress < 100) return 'Almost ready...';
  return 'Ready!';
}

export default function Onboarding() {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('');
  const [urlError, setUrlError] = useState('');
  const [copyLabel, setCopyLabel] = useState('Copy Embed Code');
  const [ingestErrorMessage, setIngestErrorMessage] = useState('Ingest failed. Please try again.');
  const [ingest, setIngest] = useState({ status: '', ingest_progress: 0 });
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const pollCountRef = useRef(0);
  const celebratedRef = useRef(false);
  const navigate = useNavigate();

  const businessId = result?.businessId || null;
  const showProgress = Boolean(businessId);
  const progressValue = Math.max(0, Math.min(100, ingest.ingest_progress || 0));
  const progressLabel = useMemo(() => getProgressLabel(progressValue), [progressValue]);
  const embedSnippet = businessId
    ? `<script src="/widget.js" data-business-id="${businessId}"></script>`
    : '';

  useEffect(() => {
    if (!businessId) {
      return undefined;
    }

    let active = true;
    let intervalId;
    pollCountRef.current = 0;

    const poll = async () => {
      if (!active) {
        return;
      }

      pollCountRef.current += 1;
      if (pollCountRef.current >= 60) {
        setIngest({ status: 'error', ingest_progress: 0 });
        setStatus('error');
        setIngestErrorMessage('Ingest is taking too long. Please try again.');
        if (intervalId) {
          clearInterval(intervalId);
        }
        return;
      }

      try {
        const response = await fetch(`${API_BASE}/api/ingest/${businessId}/status`);
        const data = await response.json();
        if (!response.ok || !active) {
          setIngest({ status: 'error', ingest_progress: 0 });
          setStatus('error');
          setIngestErrorMessage('Ingest failed. Please try again.');
          if (intervalId) {
            clearInterval(intervalId);
          }
          return;
        }

        const nextStatus = data.status || '';
        const nextProgress = Number(data.ingest_progress) || 0;

        setIngest({
          status: nextStatus,
          ingest_progress: nextProgress,
        });

        if (nextStatus === 'error') {
          setStatus('error');
          setIngestErrorMessage('Ingest failed. Please try again.');
          if (intervalId) {
            clearInterval(intervalId);
          }
          return;
        }

        if (nextStatus === 'active') {
          setStatus('Ready');
          if (intervalId) {
            clearInterval(intervalId);
          }
        }
      } catch (_error) {
        if (active) {
          setIngest({ status: 'error', ingest_progress: 0 });
          setStatus('error');
          setIngestErrorMessage('Ingest failed. Please try again.');
          if (intervalId) {
            clearInterval(intervalId);
          }
        }
      }
    };

    poll();
    intervalId = setInterval(poll, 3000);

    return () => {
      active = false;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [businessId]);

  useEffect(() => {
    if (ingest.status === 'active') {
      setStatus('Ready');
    } else if (ingest.status === 'error') {
      setStatus('Error');
    }
  }, [ingest.status]);

  useEffect(() => {
    if (ingest.status !== 'active' || celebratedRef.current) {
      return;
    }

    celebratedRef.current = true;
    confetti({
      particleCount: 80,
      spread: 70,
      colors: ['#c0c1ff', '#8083ff', '#494bd6', '#ffffff'],
    });
  }, [ingest.status]);

  function resetToForm() {
    setResult(null);
    setStatus('');
    setLoading(false);
    setIngestErrorMessage('Ingest failed. Please try again.');
    setIngest({ status: '', ingest_progress: 0 });
    setUrlError('');
    setCopyLabel('Copy Embed Code');
    pollCountRef.current = 0;
    celebratedRef.current = false;
  }

  async function handleCopy() {
    if (!embedSnippet) {
      return;
    }

    try {
      await navigator.clipboard.writeText(embedSnippet);
      setCopyLabel('Copied!');
      setTimeout(() => setCopyLabel('Copy Embed Code'), 2000);
    } catch (_error) {
      setCopyLabel('Copy Embed Code');
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();

    const validationError = validateBusinessUrl(url);
    if (validationError) {
      setUrlError(validationError);
      return;
    }

    setUrlError('');
    setStatus('Processing...');
    setResult(null);
    setLoading(true);
    setIngestErrorMessage('Ingest failed. Please try again.');
    setIngest({ status: '', ingest_progress: 0 });
    pollCountRef.current = 0;

    try {
      const response = await fetch(`${API_BASE}/api/businesses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, url }),
      });

      const data = await response.json();

      if (!response.ok) {
        setStatus('Error');
        setResult(data);
        return;
      }

      setStatus('Processing...');
      setResult({
        businessId: data.businessId,
        embedIframe: data.embedIframe,
        embedUrl: `/embed/${data.businessId}`,
        embedScript: data.embedScript,
        dashboard: `/dashboard/${data.businessId}`,
      });
      setIngest({
        status: data.status || 'ingesting',
        ingest_progress: 0,
      });
    } catch (err) {
      setStatus('Network error');
      setResult({ error: err.message });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="ob2-page">
      <style>{`
        .ob2-page {
          min-height: 100vh;
          background: #0e0e0e;
          position: relative;
          overflow: hidden;
          color: #fff;
          font-family: 'Manrope', sans-serif;
        }

        .ob2-mesh {
          position: fixed;
          inset: 0;
          z-index: 0;
          opacity: 0.06;
          animation: drift 20s ease-in-out infinite;
          pointer-events: none;
        }

        .ob2-navbar {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          z-index: 10;
          padding: 16px 32px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: rgba(14, 14, 14, 0.8);
          backdrop-filter: blur(12px);
        }

        .ob2-brand {
          font-family: 'Manrope', sans-serif;
          font-weight: 700;
          font-size: 1rem;
          color: #fff;
        }

        .ob2-help {
          width: 28px;
          height: 28px;
          border-radius: 50%;
          border: none;
          background: rgba(255, 255, 255, 0.08);
          color: rgba(255, 255, 255, 0.5);
          font-weight: 700;
          cursor: pointer;
          transition: all 300ms cubic-bezier(0.4, 0, 0.2, 1);
        }

        .ob2-help:hover {
          background: rgba(255, 255, 255, 0.12);
        }

        .ob2-main {
          padding-top: 80px;
          min-height: 100vh;
          max-width: 1100px;
          margin: 0 auto;
          padding-left: 48px;
          padding-right: 48px;
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 80px;
          align-items: center;
          position: relative;
          z-index: 1;
        }

        .ob2-left h1 {
          font-family: 'Manrope', sans-serif;
          font-weight: 800;
          font-size: clamp(2.5rem, 4vw, 3.5rem);
          letter-spacing: -0.03em;
          line-height: 1.1;
          margin-bottom: 24px;
        }

        .ob2-left h1 span {
          display: block;
        }

        .ob2-highlight {
          color: #c0c1ff;
          font-style: italic;
        }

        .ob2-subtext {
          color: rgba(255, 255, 255, 0.5);
          font-size: 1rem;
          line-height: 1.6;
          max-width: 380px;
          margin-bottom: 40px;
        }

        .ob2-feature {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 16px;
        }

        .ob2-feature-icon {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: rgba(99, 102, 241, 0.2);
          border: 1px solid rgba(99, 102, 241, 0.4);
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }

        .ob2-feature-text {
          color: rgba(255, 255, 255, 0.75);
          font-size: 0.95rem;
          font-weight: 500;
        }

        .ob2-card {
          background: rgba(28, 27, 27, 0.95);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 24px;
          padding: 36px;
          backdrop-filter: blur(20px);
          box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
          position: relative;
          z-index: 2;
        }

        .ob2-card-title {
          font-family: 'Manrope', sans-serif;
          font-weight: 700;
          font-size: 1.4rem;
          color: #fff;
          margin-bottom: 6px;
        }

        .ob2-card-subtitle {
          color: rgba(255, 255, 255, 0.4);
          font-size: 0.875rem;
          margin-bottom: 28px;
          line-height: 1.5;
        }

        .ob2-label {
          font-size: 0.7rem;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.5);
          margin-bottom: 8px;
          display: block;
        }

        .ob2-input {
          background: #252525;
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 12px;
          padding: 14px 16px;
          color: #fff;
          font-size: 0.9rem;
          width: 100%;
          margin-bottom: 20px;
          outline: none;
          transition: all 300ms cubic-bezier(0.4, 0, 0.2, 1);
        }

        .ob2-input:focus {
          border-color: rgba(99, 102, 241, 0.5);
          box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
        }

        .ob2-input-error {
          border-color: rgba(248, 113, 113, 0.5);
        }

        .ob2-url-wrap {
          position: relative;
        }

        .ob2-url-wrap .ob2-input {
          padding-right: 44px;
        }

        .ob2-url-icon {
          position: absolute;
          right: 14px;
          top: 50%;
          transform: translateY(calc(-50% - 10px));
          color: rgba(255, 255, 255, 0.3);
          width: 16px;
          height: 16px;
          pointer-events: none;
        }

        .ob2-error {
          color: #f87171;
          font-size: 0.75rem;
          margin-top: -12px;
          margin-bottom: 14px;
        }

        .ob2-submit {
          background: linear-gradient(135deg, #7c7fff 0%, #6366f1 100%);
          color: #fff;
          border: none;
          border-radius: 999px;
          padding: 15px 24px;
          width: 100%;
          font-weight: 700;
          font-size: 0.95rem;
          cursor: pointer;
          margin-top: 4px;
          transition: all 300ms cubic-bezier(0.4, 0, 0.2, 1);
        }

        .ob2-submit:hover {
          background: linear-gradient(135deg, #9091ff, #7274f3);
          transform: translateY(-1px);
          box-shadow: 0 8px 24px rgba(99, 102, 241, 0.35);
        }

        .ob2-submit:disabled {
          opacity: 0.75;
          cursor: not-allowed;
          transform: none;
        }

        .ob2-meta {
          margin-top: 12px;
          font-size: 0.75rem;
          color: rgba(255, 255, 255, 0.45);
        }

        .ob2-progress-head {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 14px;
        }

        .ob2-preview-label {
          color: rgba(255, 255, 255, 0.5);
          font-size: 0.8rem;
        }

        .ob2-live-badge {
          background: rgba(99, 102, 241, 0.15);
          color: #c0c1ff;
          border: 1px solid rgba(99, 102, 241, 0.3);
          border-radius: 999px;
          padding: 3px 10px;
          font-size: 0.65rem;
          font-weight: 700;
          letter-spacing: 0.1em;
        }

        .ob2-status-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
          min-height: 24px;
        }

        .ob2-indexing {
          color: #c0c1ff;
          font-size: 0.85rem;
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }

        .ob2-spin-star {
          display: inline-block;
          animation: spin 2s linear infinite;
        }

        .ob2-confetti {
          font-size: 1rem;
        }

        .ob2-progress-track {
          background: rgba(255, 255, 255, 0.08);
          height: 6px;
          border-radius: 3px;
          margin: 10px 0 16px;
          overflow: hidden;
        }

        .ob2-progress-fill {
          background: linear-gradient(90deg, #6366f1, #c0c1ff);
          height: 100%;
          border-radius: 3px;
          width: 0;
          transition: width 0.6s ease;
        }

        .ob2-progress-text {
          font-size: 0.7rem;
          font-weight: 700;
          letter-spacing: 0.1em;
          color: rgba(255, 255, 255, 0.4);
          text-transform: uppercase;
        }

        .ob2-progress-label {
          margin-top: 10px;
          color: rgba(255, 255, 255, 0.5);
          font-size: 0.8rem;
        }

        .ob2-divider {
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          margin: 20px 0;
        }

        .ob2-embed-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
        }

        .ob2-embed-label {
          color: #fff;
          font-size: 0.875rem;
          font-weight: 600;
        }

        .ob2-copy {
          background: transparent;
          color: #c0c1ff;
          font-size: 0.8rem;
          border: none;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          white-space: nowrap;
        }

        .ob2-code {
          background: #151515;
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 12px;
          padding: 16px;
          margin-top: 10px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
          font-size: 0.8rem;
          color: rgba(255, 255, 255, 0.7);
          line-height: 1.6;
          word-break: break-all;
        }

        .ob2-actions {
          margin-top: 14px;
          display: grid;
          gap: 10px;
        }

        .ob2-secondary {
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 999px;
          background: transparent;
          color: rgba(255, 255, 255, 0.8);
          padding: 12px 20px;
          font-weight: 600;
          cursor: pointer;
          transition: all 300ms cubic-bezier(0.4, 0, 0.2, 1);
        }

        .ob2-secondary:hover {
          border-color: rgba(255, 255, 255, 0.16);
          color: #fff;
        }

        .ob2-link {
          color: #c0c1ff;
          text-decoration: none;
          font-size: 0.86rem;
          text-align: center;
        }

        .ob2-link:hover {
          text-decoration: underline;
        }

        @keyframes drift {
          0% { transform: translateX(0) translateY(0); }
          50% { transform: translateX(-20px) translateY(-10px); }
          100% { transform: translateX(0) translateY(0); }
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        @media (max-width: 768px) {
          .ob2-main {
            grid-template-columns: 1fr;
            gap: 24px;
            padding-left: 16px;
            padding-right: 16px;
            align-content: center;
          }

          .ob2-left {
            display: none;
          }

          .ob2-card {
            width: 100%;
            padding: 24px;
          }

          .ob2-card-title {
            font-size: 1.2rem;
          }

          .ob2-card-subtitle {
            font-size: 0.82rem;
          }
        }
      `}</style>

      <svg className="ob2-mesh" viewBox="0 0 1200 800" preserveAspectRatio="none" aria-hidden="true">
        <g fill="none" stroke="#9ca3af" strokeWidth="1">
          <path d="M-20 120 C 220 10, 360 230, 640 120 C 850 40, 1020 180, 1240 90" />
          <path d="M-50 220 C 220 130, 390 350, 670 220 C 890 120, 1070 310, 1250 210" />
          <path d="M-30 340 C 230 250, 430 470, 700 350 C 930 240, 1080 430, 1260 330" />
          <path d="M-40 460 C 260 360, 430 600, 730 470 C 960 360, 1120 560, 1280 430" />
          <path d="M-20 600 C 250 510, 450 700, 760 590 C 980 510, 1130 700, 1290 600" />
        </g>
      </svg>

      <header className="ob2-navbar">
        <div className="ob2-brand">Glazed AI</div>
        <button className="ob2-help" type="button" aria-label="Help">?</button>
      </header>

      <section className="ob2-main">
        <aside className="ob2-left">
          <h1>
            <span>Power your</span>
            <span className="ob2-highlight">Intelligence</span>
            <span>engine.</span>
          </h1>

          <p className="ob2-subtext">
            Connect your brand identity and let our AI scrape, index,
            and generate your custom sales intelligence brain in seconds.
          </p>

          <div className="ob2-feature">
            <span className="ob2-feature-icon" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M2 6.5L4.5 9L10 3" stroke="#c0c1ff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="ob2-feature-text">Instant Brand Scraping</span>
          </div>

          <div className="ob2-feature">
            <span className="ob2-feature-icon" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M2 6.5L4.5 9L10 3" stroke="#c0c1ff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="ob2-feature-text">Neural Knowledge Indexing</span>
          </div>
        </aside>

        <section className="ob2-card">
          {!showProgress ? (
            <form onSubmit={handleSubmit}>
              <h2 className="ob2-card-title">Configure Source</h2>
              <p className="ob2-card-subtitle">Enter your business details to begin the ingestion process.</p>

              <label htmlFor="business-name" className="ob2-label">Business Name</label>
              <input
                id="business-name"
                className="ob2-input"
                placeholder="Acme Inc."
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />

              <label htmlFor="business-url" className="ob2-label">Website URL</label>
              <div className="ob2-url-wrap">
                <input
                  id="business-url"
                  className={`ob2-input ${urlError ? 'ob2-input-error' : ''}`}
                  placeholder="https://example.com"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    if (urlError) {
                      setUrlError('');
                    }
                  }}
                  required
                />
                <svg className="ob2-url-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M3 12H21" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M12 3C14.5 5.4 16 8.6 16 12C16 15.4 14.5 18.6 12 21" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M12 3C9.5 5.4 8 8.6 8 12C8 15.4 9.5 18.6 12 21" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              </div>

              {urlError && <p className="ob2-error">{urlError}</p>}

              <button className="ob2-submit" type="submit" disabled={loading}>
                {loading ? 'Creating...' : 'Start Scraping 🚀'}
              </button>

              {status && <p className="ob2-meta">{status}</p>}
              {result?.error && <p className="ob2-error">{result.error}</p>}
            </form>
          ) : (
            <div>
              <div className="ob2-progress-head">
                <span className="ob2-preview-label">Success state preview</span>
                <span className="ob2-live-badge">LIVE PREVIEW</span>
              </div>

              <div className="ob2-status-row">
                <span className="ob2-indexing">
                  <span className="ob2-spin-star">✦</span>
                  {ingest.status === 'active' ? 'Indexing complete' : 'Indexing brain...'}
                </span>
                {progressValue >= 100 && <span className="ob2-confetti" aria-label="complete">🎉</span>}
              </div>

              <div className="ob2-progress-track" role="progressbar" aria-valuenow={progressValue}>
                <div className="ob2-progress-fill" style={{ width: `${progressValue}%` }} />
              </div>

              <p className="ob2-progress-text">STATUS: {progressValue}% COMPLETE</p>
              <p className="ob2-progress-label">{progressLabel}</p>

              {ingest.status === 'error' && (
                <>
                  <p className="ob2-error" style={{ marginTop: '12px', marginBottom: '14px' }}>{ingestErrorMessage}</p>
                  <button className="ob2-secondary" type="button" onClick={resetToForm}>
                    Try Again
                  </button>
                </>
              )}

              {ingest.status === 'active' && (
                <>
                  <div className="ob2-divider" />
                  <div className="ob2-embed-row">
                    <span className="ob2-embed-label">Embed Snippet</span>
                    <button className="ob2-copy" type="button" onClick={handleCopy}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                        <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.6" />
                        <rect x="4" y="4" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.6" />
                      </svg>
                      {copyLabel}
                    </button>
                  </div>

                  <pre className="ob2-code">{embedSnippet}</pre>

                  <div className="ob2-actions">
                    <button className="ob2-submit" type="button" onClick={() => navigate(`/dashboard/${result.businessId}`)}>
                      Open Dashboard
                    </button>
                    <a
                      href={`/embed/${businessId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ob2-link"
                    >
                      Test your chatbot →
                    </a>
                  </div>
                </>
              )}

              {result?.error && <p className="ob2-error" style={{ marginTop: '12px' }}>{result.error}</p>}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
