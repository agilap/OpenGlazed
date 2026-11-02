import { useEffect, useMemo, useRef, useState } from 'react';
import { readChatStream } from '../chatStream';

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
      {citations.map((c, i) => (
        <div className="gzd-citation" key={`${c.source}-${i}`}>
          <span className="gzd-citation-text">{c.content}</span>
          {c.source && c.source !== 'knowledge base' && c.source !== 'business summary' && (
            <span className="gzd-citation-src">{c.source}</span>
          )}
        </div>
      ))}
    </div>
  );
}

export default function EmbeddableWidget({ businessId }) {
  const [businessName, setBusinessName] = useState('Glazed');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [leadCaptured, setLeadCaptured] = useState(false);
  const [gateSkipped, setGateSkipped] = useState(false);
  const [escalationEmail, setEscalationEmail] = useState('');
  const [escalationSubmitted, setEscalationSubmitted] = useState(false);
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState([]);
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState('');
  const [greetingReady, setGreetingReady] = useState(false);
  const messagesContainerRef = useRef(null);
  const inputRef = useRef(null);

  const debugMode = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('debug') === 'true';
  }, []);

  const shouldShowGate = !leadCaptured && !gateSkipped;

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
            content: `Hi there. I'm ${businessName}'s AI assistant. Ask me anything about our products, pricing, or services.`,
            time: new Date(),
            source: 'greeting',
          },
          ...prev,
        ];
      });
      setGreetingReady(true);
    }, 400);

    return () => clearTimeout(timeout);
  }, [businessName, greetingReady]);

  useEffect(() => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  useEffect(() => {
    if (!shouldShowGate) {
      inputRef.current?.focus();
    }
  }, [shouldShowGate]);

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

  async function sendMessage(event) {
    event.preventDefault();
    const outgoing = message.trim();

    if (!sessionId || !outgoing) {
      return;
    }

    const nextMessages = [...messages, { role: 'user', content: outgoing, time: new Date() }];
    setMessages(nextMessages);
    setMessage('');
    setIsTyping(true);
    setError('');

    const assistantId = `stream-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: 'assistant', content: '', streaming: true, time: new Date(), citations: [] },
    ]);

    try {
      const response = await fetch(`${API_BASE}/api/chat/${businessId}/stream`, {
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
        } else if (evt.done) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, streaming: false, escalated: Boolean(evt.escalated), source: evt.source || null, citations: evt.citations || [] }
                : m
            )
          );
          if (evt.escalated && !leadCaptured && !email) {
            setEscalationSubmitted(false);
          }
        }
      });
    } catch (_error) {
      setError('Network error — please try again.');
      setMessages((prev) => prev.filter((m) => m.id !== assistantId));
    } finally {
      setIsTyping(false);
    }
  }

  function formatTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  return (
    <div className="gzd-widget-root">
      <style>{`
        .gzd-widget-root {
          height: 100vh;
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
        .gzd-header { flex-shrink: 0; padding: 16px 20px; background: #121218; color: #f4f4f5; }
        .gzd-name { margin: 0 0 4px; font-size: 16px; font-weight: 500; overflow-wrap: anywhere; }
        .gzd-online { display: flex; align-items: center; gap: 8px; font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #a1a1aa; }
        .gzd-online-dot { width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: #34d399; }
        .gzd-messages { flex: 1; min-height: 0; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; font-size: 14px; line-height: 1.5; }
        .gzd-message-row { display: flex; min-width: 0; animation: gzd-message-in 0.2s ease; }
        .gzd-message-row.user { justify-content: flex-end; }
        .gzd-bubble-wrap { min-width: 0; max-width: 100%; display: flex; flex-direction: column; }
        .gzd-message-row.user .gzd-bubble-wrap { max-width: 80%; }
        .gzd-bubble { font-size: 14px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
        .gzd-bubble.user { padding: 9px 13px; background: #121218; color: #f4f4f5; border-radius: 8px; }
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
        .gzd-escalation-send { padding: 0 14px; background: #121218; color: #fff; border: 0; border-radius: 6px; font-weight: 600; }
        .gzd-gate { flex-shrink: 0; max-height: calc(100% - 78px); overflow-y: auto; padding: 20px; border-top: 1px solid #e4e4ea; display: flex; flex-direction: column; gap: 6px; }
        .gzd-gate h2 { margin: 0; font-size: 18px; font-weight: 500; letter-spacing: -0.01em; }
        .gzd-gate p { margin: 0 0 10px; font-size: 13px; line-height: 1.45; color: #5c5c68; }
        .gzd-gate label { font-size: 13px; color: #5c5c68; }
        .gzd-gate input { flex-shrink: 0; width: 100%; margin-bottom: 8px; }
        .gzd-gate input[type='email'] { margin-bottom: 12px; }
        .gzd-gate button { flex-shrink: 0; }
        .gzd-gate button[type='submit'] { background: #121218; color: #fff; border: 0; border-radius: 6px; font-weight: 600; }
        .gzd-gate-skip { background: transparent; color: #5c5c68; border: 0; font-size: 13px; }
        .gzd-widget-root .gzd-gate-skip:hover { background: #f4f4f5; }
        .gzd-input-bar { flex-shrink: 0; padding: 12px 16px; border-top: 1px solid #e4e4ea; display: flex; gap: 8px; }
        .gzd-input { flex: 1; width: 0; }
        .gzd-send { flex: 0 0 44px; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; background: #121218; border: 0; border-radius: 6px; }
        .gzd-powered { flex-shrink: 0; margin: 0; padding: 0 16px 10px; text-align: center; font-size: 11px; color: #5c5c68; }
        .gzd-error { margin: 0 16px 10px; color: #b91c1c; font-size: 12px; overflow-wrap: anywhere; }
        .gzd-gate .gzd-error { margin: 0; color: #b91c1c; }
        .gzd-debug { margin-top: 6px; width: fit-content; max-width: 100%; padding: 2px 7px; border-radius: 4px; background: #eef2ff; color: #494bd6; font-family: 'JetBrains Mono', monospace; font-size: 10px; }
        .gzd-citations { margin-top: 10px; border: 1px solid #e4e4ea; border-radius: 6px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; line-height: 1.45; color: #5c5c68; }
        .gzd-citations-label { font-family: 'JetBrains Mono', monospace; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
        .gzd-citation-text { display: block; overflow-wrap: anywhere; }
        .gzd-citation-src { display: block; margin-top: 2px; font-family: 'JetBrains Mono', monospace; color: #494bd6; overflow-wrap: anywhere; }
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

      <section className="gzd-messages" ref={messagesContainerRef}>
        {messages.map((msg, i) => {
          const isUser = msg.role === 'user';
          const previous = i > 0 ? messages[i - 1] : null;
          const showAssistantAvatar = !isUser && (!previous || previous.role !== 'assistant');

          return (
            <div key={msg.id || `${msg.role}-${i}-${msg.content.slice(0, 20)}`}>
              <div className={`gzd-message-row ${isUser ? 'user' : 'assistant'}`}>
                <div className="gzd-bubble-wrap">
                  <div className={`gzd-bubble ${isUser ? 'user' : 'assistant'}${msg.streaming ? ' streaming' : ''}`}>
                    {msg.content}
                    {debugMode && !isUser && msg.source && <div className="gzd-debug">{msg.source}</div>}
                  </div>
                  {!isUser && !msg.escalated && <CitationList citations={msg.citations} />}
                  <div className={`gzd-time ${isUser ? 'user' : 'assistant'}`}>{formatTime(msg.time)}</div>
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

        {isTyping && <TypingIndicator />}
      </section>

      {shouldShowGate ? (
        <form className="gzd-gate" onSubmit={startChat}>
          <h2>Before we start</h2>
          <p>Leave your details so we can follow up if needed.</p>
          <label htmlFor="gzd-name">Name (optional)</label>
          <input
            id="gzd-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label htmlFor="gzd-email">Email</label>
          <input
            id="gzd-email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <button type="submit">Start chatting</button>
          <button className="gzd-gate-skip" type="button" onClick={skipLeadCapture}>Skip for now</button>
          {error && <p className="gzd-error" role="alert">{error}</p>}
        </form>
      ) : (
        <>
          <form className="gzd-input-bar" onSubmit={sendMessage}>
            <input
              ref={inputRef}
              className="gzd-input"
              placeholder="Type your message"
              aria-label="Message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <button className="gzd-send" type="submit" disabled={!message.trim()} aria-label="Send message">
              <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M5 12H19" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M13 6L19 12L13 18" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </form>
          <div className="gzd-powered">Powered by Glazed</div>
          {error && <p className="gzd-error" role="alert">{error}</p>}
        </>
      )}
    </div>
  );
}
