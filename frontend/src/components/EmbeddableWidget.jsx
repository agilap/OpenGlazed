import { useEffect, useMemo, useRef, useState } from 'react';
import { readChatStream } from '../chatStream';
import { safeCitationUrl, colorText } from '../widgetConfig';

const API_BASE = import.meta.env.VITE_API_BASE || '';

function TypingIndicator() {
  return (
    <div className="gzd-message-row assistant" role="status" aria-label="Assistant is typing">
      <div className="gzd-bubble assistant gzd-typing-bubble">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function CitationList({ citations }) {
  if (!Array.isArray(citations) || citations.length === 0) return null;
  return (
    <div className="gzd-citations">
      <div className="gzd-citations-label">Sources</div>
      {citations.filter((c) => c && typeof c === 'object' && typeof c.content === 'string' && (!c.source || typeof c.source === 'string')).slice(0, 10).map((c, i) => (
        <div className="gzd-citation" key={`${c.source}-${i}`}>
          <span className="gzd-citation-text">[{Number.isSafeInteger(c.index) && c.index > 0 ? c.index : i + 1}] {c.content}</span>
          {c.source && c.source !== 'knowledge base' && c.source !== 'business summary' && (
            safeCitationUrl(c.source) ? <a className="gzd-citation-src" href={safeCitationUrl(c.source)} target="_blank" rel="noopener noreferrer">{c.source}</a> : <span className="gzd-citation-src">{c.source}</span>
          )}
        </div>
      ))}
    </div>
  );
}

export default function EmbeddableWidget({ businessId, config = {} }) {
  const [businessName, setBusinessName] = useState('Glazed');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [leadCaptured, setLeadCaptured] = useState(false);
  const [gateSkipped, setGateSkipped] = useState(false);
  const [followUp, setFollowUp] = useState(false);
  const [gateExpanded, setGateExpanded] = useState(() => !window.matchMedia('(max-height: 650px)').matches);
  const [escalationEmail, setEscalationEmail] = useState('');
  const [escalationSubmitted, setEscalationSubmitted] = useState(false);
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState([]);
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState('');
  const [retryMessage, setRetryMessage] = useState('');
  const busyRef = useRef(false);
  const nearBottomRef = useRef(true);
  const requestRef = useRef(null);
  const queuedRef = useRef(false);

  useEffect(() => () => requestRef.current?.abort(), []);
  const [greetingReady, setGreetingReady] = useState(false);
  const messagesContainerRef = useRef(null);
  const inputRef = useRef(null);

  const debugMode = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('debug') === 'true';
  }, []);

  // Ask for an email only after a question the documents could not answer.
  const shouldShowGate = followUp && !leadCaptured && !gateSkipped;

  useEffect(() => {
    const key = `glazed_session_${businessId}`;
    let nextSession = null;
    try {
      nextSession = localStorage.getItem(key);
    } catch (_err) {}
    if (!nextSession) {
      nextSession = crypto.randomUUID();
      try {
        localStorage.setItem(key, nextSession);
      } catch (_err) {}
    }
    setSessionId(nextSession);
  }, [businessId]);

  useEffect(() => {
    if (!sessionId) return undefined;
    let active = true;

    async function loadHistory() {
      try {
        const response = await fetch(
          `${API_BASE}/api/chat/${businessId}/history?sessionId=${encodeURIComponent(sessionId)}`
        );
        const rows = await response.json();
        if (!active || !response.ok || !Array.isArray(rows) || rows.length === 0) return;
        const restored = rows.map((m) => ({ role: m.role, content: m.content, time: new Date(m.created_at) }));
        setMessages((prev) => [...prev.filter((m) => m.isGreeting), ...restored]);
        setGateSkipped(true);
      } catch (_error) {}
    }

    loadHistory();
    return () => {
      active = false;
    };
  }, [businessId, sessionId]);

  useEffect(() => {
    let active = true;

    async function loadBusinessName() {
      try {
        const response = await fetch(`${API_BASE}/api/businesses/${businessId}`);
        const data = await response.json();
        if (!active || !response.ok || data?.error) {
          return;
        }
        if (data?.business?.name) {
          setBusinessName(data.business.name);
        }
      } catch (_error) {
      }
    }

    loadBusinessName();
    return () => {
      active = false;
    };
  }, [businessId]);

  useEffect(() => {
    if (greetingReady) {
      return;
    }

    const timeout = setTimeout(() => {
      setMessages((prev) => {
        if (prev.some((m) => m.isGreeting)) {
          return prev;
        }

        return [
          {
            role: 'assistant',
            isGreeting: true,
            content: config.greeting || `Hi! I answer questions from ${businessName}'s documents. What would you like to know?`,
            time: new Date(),
            source: 'greeting',
          },
          ...prev,
        ];
      });
      setGreetingReady(true);
    }, 400);

    return () => clearTimeout(timeout);
  }, [businessName, greetingReady, config.greeting]);

  useEffect(() => {
    if (config.greeting) setMessages((prev) => prev.map((m) => m.isGreeting ? { ...m, content: config.greeting } : m));
  }, [config.greeting]);

  useEffect(() => {
    if (messagesContainerRef.current && nearBottomRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function startChat(event) {
    event.preventDefault();
    if (!sessionId) return;

    setError('');

    try {
      const response = await fetch(`${API_BASE}/api/chat/${businessId}/lead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, name: name || null, email }),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.error || 'Could not start chat.');
        return;
      }

      setLeadCaptured(true);
      setGateSkipped(false);
      setEscalationSubmitted(true);
    } catch (_error) {
      setError('Network error — please try again.');
    }
  }

  function skipLeadCapture(event) {
    event.preventDefault();
    setGateSkipped(true);
    setLeadCaptured(false);
  }

  async function submitEscalationLead(event) {
    event.preventDefault();

    if (!sessionId || !escalationEmail.trim()) {
      return;
    }

    setError('');

    try {
      const response = await fetch(`${API_BASE}/api/chat/${businessId}/lead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          name: name || null,
          email: escalationEmail.trim(),
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.error || 'Could not save your email.');
        return;
      }

      setEmail(escalationEmail.trim());
      setLeadCaptured(true);
      setEscalationSubmitted(true);
      setEscalationEmail('');
    } catch (_error) {
      setError('Network error — please try again.');
    }
  }

  async function sendMessage(event, retry = '', queued = '') {
    event?.preventDefault();
    const outgoing = (retry || queued || message).trim();

    if (!sessionId || !outgoing) return;
    if (busyRef.current) {
      // The reply is still being checked; send this as soon as it finishes instead of dropping it.
      if (!retry) queuedRef.current = true;
      return;
    }

    busyRef.current = true;
    nearBottomRef.current = true;
    setRetryMessage('');
    if (!retry) setMessages((prev) => [...prev, { role: 'user', content: outgoing, time: new Date() }]);
    setMessage('');
    setIsTyping(true);
    setError('');

    const assistantId = `stream-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: 'assistant', content: '', streaming: true, time: new Date(), citations: [] },
    ]);

    const controller = new AbortController();
    requestRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      const response = await fetch(`${API_BASE}/api/chat/${businessId}/stream`, {
        signal: controller.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          message: outgoing,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error('Stream failed');
      }

      await readChatStream(response, (evt) => {
        if (evt.token) {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + evt.token } : m))
          );
        } else if (evt.citations && !evt.done) {
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, streaming: false, citations: evt.citations } : m)));
        } else if (evt.done) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, streaming: false, escalated: Boolean(evt.escalated), source: evt.source || null, citations: Array.isArray(evt.citations) ? evt.citations : [] }
                : m
            )
          );
          if (evt.followUp && !leadCaptured && !gateSkipped) { setFollowUp(true); setGateExpanded(true); }
          if (evt.escalated && !leadCaptured && !email && !evt.followUp) {
            setEscalationSubmitted(false);
          }
        }
      });
    } catch (err) {
      setError(err.name === 'AbortError' ? 'The request timed out. Please retry.' : err.message || 'Connection failed. Please retry.');
      setRetryMessage(outgoing);
      setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, streaming: false, interrupted: true } : m));
    } finally {
      clearTimeout(timeout);
      busyRef.current = false;
      setIsTyping(false);
      inputRef.current?.focus();
      const pending = queuedRef.current && inputRef.current?.value;
      queuedRef.current = false;
      if (pending && pending.trim()) setTimeout(() => sendMessage(null, '', pending));
    }
  }

  function formatTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  return (
    <div className="gzd-widget-root" data-theme={config.dark ? 'dark' : 'light'} style={{ '--gzd-accent': config.color || '#121218', '--gzd-accent-text': colorText(config.color || '#121218') }}>
      <style>{`
        .gzd-widget-root {
          height: 100vh;
          height: 100dvh;
          width: 100%;
          min-width: 0;
          display: flex;
          flex-direction: column;
          background: #fff;
          color: #121218;
          font-family: Inter, sans-serif;
          overflow: hidden;
          position: relative;
        }
        .gzd-widget-root * { box-sizing: border-box; }
        .gzd-widget-root :is(button, input) { font-family: inherit; font-size: 14px; }
        .gzd-widget-root :is(button, input, a):focus-visible { outline: 2px solid #494bd6; outline-offset: 3px; }
        .gzd-widget-root button { min-height: 44px; cursor: pointer; }
        .gzd-widget-root button:hover:not(:disabled) { background: #2a2a33; }
        .gzd-widget-root button:disabled { background: #d3d3dc; cursor: not-allowed; }
        .gzd-widget-root input { min-height: 44px; min-width: 0; padding: 0 12px; background: #fff; color: #121218; border: 1px solid #c8c8d2; border-radius: 6px; }
        .gzd-widget-root input::placeholder { color: #6b6b78; }
        .gzd-header { flex-shrink: 0; padding: 16px 20px; background: var(--gzd-accent); color: var(--gzd-accent-text); }
        .gzd-name { margin: 0 0 4px; font-size: 16px; font-weight: 500; overflow-wrap: anywhere; }
        .gzd-online { display: flex; align-items: center; gap: 8px; font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #a1a1aa; }
        .gzd-online-dot { width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: #34d399; }
        .gzd-messages { flex: 1; min-height: 0; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; font-size: 14px; line-height: 1.5; }
        .gzd-message-row { display: flex; min-width: 0; animation: gzd-message-in 0.2s ease; }
        .gzd-message-row.user { justify-content: flex-end; }
        .gzd-bubble-wrap { min-width: 0; max-width: 100%; display: flex; flex-direction: column; }
        .gzd-message-row.user .gzd-bubble-wrap { max-width: 80%; }
        .gzd-bubble { font-size: 14px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
        .gzd-bubble.user { padding: 9px 13px; background: var(--gzd-accent); color: var(--gzd-accent-text); border-radius: 8px; }
        .gzd-bubble.streaming::after { content: '▌'; color: #494bd6; animation: gzd-blink 1s step-start infinite; }
        .gzd-time { margin-top: 4px; font-family: 'JetBrains Mono', monospace; font-size: 10px; color: #6b6b78; }
        .gzd-time.user { text-align: right; }
        .gzd-typing-bubble { min-height: 24px; display: flex; align-items: center; gap: 4px; }
        .gzd-typing-bubble span { width: 6px; height: 6px; border-radius: 50%; background: #6b6b78; animation: gzd-typing-dots 0.6s infinite; }
        .gzd-typing-bubble span:nth-child(2) { animation-delay: 0.15s; }
        .gzd-typing-bubble span:nth-child(3) { animation-delay: 0.3s; }
        .gzd-escalation { margin-top: 12px; border: 1px solid #e4e4ea; border-radius: 6px; padding: 14px; display: flex; flex-direction: column; gap: 8px; animation: gzd-message-in 0.2s ease; }
        .gzd-escalation-title { font-size: 14px; font-weight: 500; }
        .gzd-escalation-sub { margin: 0; font-size: 13px; line-height: 1.45; color: #5c5c68; }
        .gzd-escalation-row { display: flex; gap: 8px; }
        .gzd-escalation-input { flex: 1; width: 0; }
        .gzd-escalation-send { padding: 0 14px; background: var(--gzd-accent); color: var(--gzd-accent-text); border: 0; border-radius: 6px; font-weight: 600; }
        .gzd-gate { flex-shrink: 0; max-height: 40%; overflow-y: auto; margin: 0 16px 8px; padding: 12px; border: 1px solid #e4e4ea; border-radius: 8px; display: flex; flex-direction: column; gap: 8px; }
        .gzd-gate h2 { margin: 0; font-size: 14px; font-weight: 600; }
        .gzd-gate p { margin: 0; font-size: 13px; line-height: 1.4; color: #5c5c68; }
        .gzd-gate-fields, .gzd-gate-actions { display: flex; gap: 8px; }
        .gzd-gate-fields input { flex: 1; width: 0; }
        .gzd-gate-actions button { flex: 1; }
        .gzd-gate button[type='submit'] { background: var(--gzd-accent); color: var(--gzd-accent-text); border: 0; border-radius: 6px; font-weight: 600; }
        .gzd-gate-skip, .gzd-gate-toggle { background: transparent; color: #5c5c68; border: 1px solid #c8c8d2; border-radius: 6px; }
        .gzd-widget-root :is(.gzd-gate-skip,.gzd-gate-toggle):hover { background: #f4f4f5; }
        .gzd-gate-toggle { flex-shrink: 0; margin: 0 16px 8px; padding: 0 12px; text-align: left; }
        .gzd-input-bar { flex-shrink: 0; padding: 12px 16px; padding-bottom: max(12px, env(safe-area-inset-bottom)); border-top: 1px solid #e4e4ea; display: flex; gap: 8px; }
        .gzd-input { flex: 1; width: 0; }
        .gzd-send { flex: 0 0 44px; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; background: var(--gzd-accent); color: var(--gzd-accent-text); border: 0; border-radius: 6px; }
        .gzd-powered { flex-shrink: 0; margin: 0; padding: 0 16px 10px; text-align: center; font-size: 11px; color: #5c5c68; }
        .gzd-error { margin: 0 16px 10px; color: #b91c1c; font-size: 12px; overflow-wrap: anywhere; }
        .gzd-gate .gzd-error { margin: 0; color: #b91c1c; }
        .gzd-debug { margin-top: 6px; width: fit-content; max-width: 100%; padding: 2px 7px; border-radius: 4px; background: #eef2ff; color: #494bd6; font-family: 'JetBrains Mono', monospace; font-size: 10px; }
        .gzd-citations { margin-top: 10px; border: 1px solid #e4e4ea; border-radius: 6px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; line-height: 1.45; color: #5c5c68; }
        .gzd-citations-label { font-family: 'JetBrains Mono', monospace; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
        .gzd-citation-text { display: block; overflow-wrap: anywhere; }
        .gzd-citation-src { display: block; margin-top: 2px; font-family: 'JetBrains Mono', monospace; color: #494bd6; overflow-wrap: anywhere; }
        .gzd-widget-root[data-theme='dark'] { background: #18181b; color: #f4f4f5; }
        .gzd-widget-root[data-theme='dark'] input { background: #27272a; color: #fafafa; }
        .gzd-widget-root[data-theme='dark'] :is(.gzd-time,.gzd-powered,.gzd-gate p,.gzd-gate label,.gzd-citations) { color: #d4d4d8; }
        .gzd-widget-root[data-theme='dark'] .gzd-citation-src { color: #a5b4fc; }
        .gzd-retry { margin: 0 16px 12px; min-height: 44px; }
        .gzd-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
        @media (max-width: 400px) { .gzd-messages { padding: 16px; } .gzd-widget-root input { font-size: 16px; } }
        @keyframes gzd-blink { 50% { opacity: 0; } }
        @keyframes gzd-typing-dots { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-4px); } }
        @keyframes gzd-message-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        @media (prefers-reduced-motion: reduce) {
          .gzd-widget-root *, .gzd-bubble.streaming::after { animation: none; transition: none; }
        }
      `}</style>

      <header className="gzd-header">
        <div className="gzd-name">{businessName}</div>
        <div className="gzd-online">
          <span className="gzd-online-dot" aria-hidden="true" />
          <span>online</span>
        </div>
      </header>

      <section className="gzd-messages" ref={messagesContainerRef} aria-label="Chat messages" role="log" aria-live="off" onScroll={(e) => { const el = e.currentTarget; nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {messages.map((msg, i) => {
          const isUser = msg.role === 'user';

          return (
            <div key={msg.id || `${msg.role}-${i}-${msg.content.slice(0, 20)}`}>
              <div className={`gzd-message-row ${isUser ? 'user' : 'assistant'}`}>
                <div className="gzd-bubble-wrap">
                  <div className={`gzd-bubble ${isUser ? 'user' : 'assistant'}${msg.streaming ? ' streaming' : ''}`}>
                    {msg.content}
                    {debugMode && !isUser && msg.source && <div className="gzd-debug">{msg.source}</div>}
                  </div>
                  {msg.interrupted && <span className="gzd-time">Response interrupted</span>}
                  {!isUser && !msg.escalated && <CitationList citations={msg.citations} />}
                  {!msg.isGreeting && <div className={`gzd-time ${isUser ? 'user' : 'assistant'}`}>{formatTime(msg.time)}</div>}
                </div>
              </div>

              {!isUser && msg.escalated && !leadCaptured && !escalationSubmitted && (
                <form className="gzd-escalation" onSubmit={submitEscalationLead}>
                  <label className="gzd-escalation-title" htmlFor={`gzd-followup-${i}`}>Want a follow-up?</label>
                  <div className="gzd-escalation-sub">Leave your email and we&apos;ll get back to you.</div>
                  <div className="gzd-escalation-row">
                    <input
                      id={`gzd-followup-${i}`}
                      className="gzd-escalation-input"
                      type="email"
                      placeholder="you@example.com"
                      value={escalationEmail}
                      onChange={(e) => setEscalationEmail(e.target.value)}
                      required
                    />
                    <button className="gzd-escalation-send" type="submit">Send</button>
                  </div>
                </form>
              )}
            </div>
          );
        })}

        {isTyping && !messages.some((m) => m.streaming && m.content) && <TypingIndicator />}
      </section>

      <div className="gzd-status" role="status" aria-live="polite">{isTyping ? 'Assistant is responding…' : messages.at(-1)?.role === 'assistant' && !messages.at(-1)?.isGreeting ? 'Response ready.' : ''}</div>
      {shouldShowGate && (gateExpanded ? (
        <form className="gzd-gate" onSubmit={startChat}>
          <h2>Want a follow-up?</h2>
          <p>{followUp ? "I don't have that detail yet. Leave your email and the team will follow up." : "Leave your email and we'll get back to you."}</p>
          <div className="gzd-gate-fields">
            <input aria-label="Name (optional)" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
            <input aria-label="Email" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="gzd-gate-actions">
            <button type="submit">Send</button>
            <button className="gzd-gate-skip" type="button" onClick={skipLeadCapture}>Not now</button>
          </div>
          {error && <p className="gzd-error" role="alert">{error}</p>}
        </form>
      ) : (
        <button className="gzd-gate-toggle" type="button" onClick={() => setGateExpanded(true)}>Want a follow-up? Leave your email</button>
      ))}
          <form className="gzd-input-bar" onSubmit={sendMessage}>
            <input
              ref={inputRef}
              className="gzd-input"
              placeholder="Type your message"
              aria-label="Message"
              maxLength={4000}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <button className="gzd-send" type="submit" disabled={!message.trim() || !sessionId} aria-label="Send message">
              <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M5 12H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M13 6L19 12L13 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </form>
          <div className="gzd-powered">Powered by Glazed</div>
          {error && !shouldShowGate && <p className="gzd-error" role="alert">{error}</p>}
          {retryMessage && <button className="gzd-retry" type="button" disabled={isTyping} onClick={() => sendMessage(null, retryMessage)}>Retry message</button>}
    </div>
  );
}
