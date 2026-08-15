import { useEffect, useMemo, useRef, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE || '';

function TypingIndicator() {
  return (
    <div className="gzd-message-row assistant">
      <div className="gzd-assistant-avatar placeholder" aria-hidden="true" />
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
    const existing = sessionStorage.getItem('glazed_session');
    const nextSession = existing || crypto.randomUUID();
    sessionStorage.setItem('glazed_session', nextSession);
    setSessionId(nextSession);
  }, []);

  useEffect(() => {
    let active = true;

    async function loadBusinessName() {
      try {
        const response = await fetch(`${API_BASE}/api/businesses/${businessId}/dashboard`);
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
          ...prev,
          {
            role: 'assistant',
            isGreeting: true,
            content: `Hi there! 👋 I'm ${businessName}'s AI assistant. Ask me anything about our products, pricing, or services.`,
            time: new Date(),
            source: 'greeting',
          },
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

    try {
      const response = await fetch(`${API_BASE}/api/chat/${businessId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          message: outgoing,
          conversationHistory: nextMessages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.error || 'Could not send message.');
        return;
      }

      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: data.response || 'I could not generate a response.',
          time: new Date(),
          escalated: Boolean(data.escalated),
          source: data.source || null,
          citations: data.citations || [],
        },
      ]);

      if (data.escalated && !leadCaptured && !email) {
        setEscalationSubmitted(false);
      }
    } catch (_error) {
      setError('Network error — please try again.');
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
        :root {
          --gzd-transition: 300ms cubic-bezier(0.4, 0, 0.2, 1);
          --gzd-radius-sm: 0.25rem;
          --gzd-radius-md: 0.5rem;
          --gzd-radius-lg: 1rem;
          --gzd-radius-xl: 1.5rem;
          --gzd-radius-full: 999px;
        }

        .gzd-widget-root {
          height: 100vh;
          display: flex;
          flex-direction: column;
          background: #ffffff;
          font-family: 'Manrope', sans-serif;
          overflow: hidden;
          position: relative;
        }

        .gzd-widget-root * {
          box-sizing: border-box;
        }

        .gzd-header {
          background:
            radial-gradient(at 0% 0%, hsla(243, 98%, 71%, 1) 0, transparent 50%),
            radial-gradient(at 100% 0%, hsla(225, 89%, 57%, 1) 0, transparent 50%),
            #5254cc;
          padding: 20px 20px 44px 20px;
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
        }

        .gzd-online {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          color: rgba(255, 255, 255, 0.7);
          font-size: 0.7rem;
          margin-bottom: 6px;
        }

        .gzd-online-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #4ade80;
          animation: pulseRing 2s infinite;
        }

        .gzd-name {
          color: #fff;
          font-size: 1rem;
          font-weight: 600;
          margin-bottom: 2px;
        }

        .gzd-subname {
          color: rgba(255, 255, 255, 0.6);
          font-size: 0.75rem;
        }

        .gzd-header-avatar {
          width: 48px;
          height: 48px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.15);
          border: 1.5px solid rgba(255, 255, 255, 0.3);
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }

        .gzd-header-avatar svg {
          color: #fff;
        }

        .gzd-messages {
          flex: 1;
          overflow-y: auto;
          padding: 16px;
          background: #f8fafc;
          margin-top: -24px;
          border-radius: 20px 20px 0 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .gzd-messages::-webkit-scrollbar { width: 4px; }
        .gzd-messages::-webkit-scrollbar-track { background: transparent; }
        .gzd-messages::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 2px; }

        .gzd-message-row {
          display: flex;
          align-items: flex-end;
          gap: 6px;
          animation: messageIn 0.2s ease forwards;
        }

        .gzd-message-row.user {
          justify-content: flex-end;
        }

        .gzd-message-row.assistant {
          justify-content: flex-start;
        }

        .gzd-assistant-avatar {
          width: 24px;
          height: 24px;
          border-radius: var(--gzd-radius-full);
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          color: #fff;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 0.7rem;
          flex-shrink: 0;
          margin-bottom: 18px;
        }

        .gzd-assistant-avatar.placeholder {
          opacity: 0;
        }

        .gzd-bubble-wrap {
          max-width: 78%;
          display: flex;
          flex-direction: column;
        }

        .gzd-bubble {
          padding: 10px 14px;
          font-size: 0.875rem;
          line-height: 1.45;
          word-break: break-word;
        }

        .gzd-bubble.user {
          background: #494bd6;
          color: #fff;
          border-radius: 12px 12px 2px 12px;
          box-shadow: 0 2px 8px rgba(73, 75, 214, 0.3);
        }

        .gzd-bubble.assistant {
          background: #fff;
          color: #1e293b;
          border-radius: 12px 12px 12px 2px;
          border: 1px solid #e2e8f0;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
        }

        .gzd-time {
          font-size: 0.65rem;
          color: #94a3b8;
          margin-top: 2px;
        }

        .gzd-time.user {
          align-self: flex-end;
          text-align: right;
        }

        .gzd-time.assistant {
          align-self: flex-start;
          text-align: left;
        }

        .gzd-typing-bubble {
          display: flex;
          gap: 4px;
          padding: 12px 16px;
          align-items: center;
        }

        .gzd-typing-bubble span {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #94a3b8;
          animation: typingDots 0.6s infinite;
        }

        .gzd-typing-bubble span:nth-child(1) { animation-delay: 0s; }
        .gzd-typing-bubble span:nth-child(2) { animation-delay: 0.15s; }
        .gzd-typing-bubble span:nth-child(3) { animation-delay: 0.3s; }

        .gzd-escalation {
          background: linear-gradient(135deg, #fffbeb, #fef3c710);
          border: 1px solid #fde68a;
          border-radius: var(--gzd-radius-lg);
          padding: 14px 16px;
          margin: 4px 0 4px 30px;
          animation: messageIn 0.2s ease forwards;
        }

        .gzd-escalation-title {
          font-weight: 600;
          color: #92400e;
          font-size: 0.875rem;
        }

        .gzd-escalation-sub {
          color: #78350f;
          font-size: 0.8rem;
          margin: 4px 0 10px;
        }

        .gzd-escalation-row {
          display: flex;
          gap: 8px;
        }

        .gzd-escalation-input {
          flex: 1;
          background: #fff;
          border: 1px solid #fcd34d;
          border-radius: var(--gzd-radius-sm);
          padding: 8px 10px;
          font-size: 0.8rem;
          outline: none;
        }

        .gzd-escalation-send {
          background: #f59e0b;
          color: #fff;
          border: none;
          border-radius: var(--gzd-radius-sm);
          padding: 8px 14px;
          font-weight: 600;
          cursor: pointer;
        }

        .gzd-gate {
          position: absolute;
          bottom: 0;
          left: 0;
          right: 0;
          background: #fff;
          border-radius: 20px 20px 0 0;
          padding: 24px 20px 20px;
          box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.08);
        }

        .gzd-gate h3 {
          font-weight: 700;
          color: #1e293b;
          font-size: 1rem;
          margin-bottom: 4px;
        }

        .gzd-gate p {
          color: #64748b;
          font-size: 0.8rem;
          margin-bottom: 16px;
        }

        .gzd-gate input {
          width: 100%;
          margin-bottom: 8px;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: var(--gzd-radius-md);
          padding: 10px 12px;
          font-size: 0.875rem;
          outline: none;
          transition: var(--gzd-transition);
        }

        .gzd-gate input:focus {
          border-color: #6366f1;
          box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
        }

        .gzd-gate button[type='submit'] {
          width: 100%;
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          color: #fff;
          border: none;
          border-radius: var(--gzd-radius-xl);
          padding: 12px;
          font-weight: 700;
          font-size: 0.875rem;
          cursor: pointer;
          transition: var(--gzd-transition);
        }

        .gzd-gate button[type='submit']:hover {
          opacity: 0.9;
          transform: translateY(-1px);
        }

        .gzd-gate-skip {
          display: block;
          width: 100%;
          text-align: center;
          margin-top: 10px;
          color: #94a3b8;
          font-size: 0.8rem;
          border: 0;
          background: transparent;
          cursor: pointer;
          transition: var(--gzd-transition);
        }

        .gzd-gate-skip:hover {
          color: #64748b;
        }

        .gzd-input-bar {
          background: #fff;
          border-top: 1px solid #f1f5f9;
          padding: 12px 16px;
          display: flex;
          gap: 8px;
          align-items: center;
        }

        .gzd-input {
          flex: 1;
          background: #f1f5f9;
          border: 1px solid transparent;
          border-radius: var(--gzd-radius-full);
          padding: 10px 16px;
          font-size: 0.875rem;
          color: #1e293b;
          outline: none;
          transition: var(--gzd-transition);
        }

        .gzd-input::placeholder {
          color: #94a3b8;
        }

        .gzd-input:focus {
          background: #fff;
          border-color: #6366f1;
          box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
        }

        .gzd-send {
          width: 38px;
          height: 38px;
          border-radius: var(--gzd-radius-full);
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          border: none;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: var(--gzd-transition);
        }

        .gzd-send:hover {
          transform: scale(1.05);
        }

        .gzd-send:active {
          transform: scale(0.95);
        }

        .gzd-send:disabled {
          background: #e2e8f0;
          cursor: not-allowed;
          transform: none;
        }

        .gzd-powered {
          text-align: center;
          padding: 8px;
          font-size: 0.65rem;
          color: #cbd5e1;
          background: #fff;
          border-top: 1px solid #f1f5f9;
        }

        .gzd-error {
          color: #ef4444;
          font-size: 0.75rem;
          margin-top: 6px;
        }

        .gzd-debug {
          margin-top: 6px;
          display: inline-block;
          padding: 2px 7px;
          border-radius: 999px;
          background: #eef2ff;
          color: #4f46e5;
          font-size: 0.65rem;
          font-weight: 600;
        }

        @keyframes pulseRing {
          0% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.7); }
          70% { box-shadow: 0 0 0 6px rgba(74, 222, 128, 0); }
          100% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0); }
        }

        @keyframes typingDots {
          0%, 60%, 100% { transform: translateY(0); }
          30% { transform: translateY(-5px); }
        }

        @keyframes messageIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .gzd-citations {
          margin-top: 6px;
          padding: 8px 10px;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-left: 3px solid #6366f1;
          border-radius: 8px;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .gzd-citations-label {
          font-size: 0.6rem;
          font-weight: 700;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          color: #94a3b8;
        }

        .gzd-citation {
          font-size: 0.7rem;
          color: #475569;
          line-height: 1.35;
        }

        .gzd-citation-text {
          display: block;
        }

        .gzd-citation-src {
          display: block;
          margin-top: 2px;
          font-size: 0.62rem;
          color: #6366f1;
          word-break: break-all;
        }
      `}</style>

      <header className="gzd-header">
        <div>
          <div className="gzd-online">
            <span className="gzd-online-dot" />
            <span>Online now</span>
          </div>
          <div className="gzd-name">{businessName}</div>
          <div className="gzd-subname">Typically replies instantly</div>
        </div>

        <div className="gzd-header-avatar" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <rect x="4" y="7" width="16" height="10" rx="3" stroke="currentColor" strokeWidth="1.8" />
            <circle cx="9" cy="12" r="1.2" fill="currentColor" />
            <circle cx="15" cy="12" r="1.2" fill="currentColor" />
            <path d="M12 3v2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M8 20h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </div>
      </header>

      <section className="gzd-messages" ref={messagesContainerRef}>
        {messages.map((msg, i) => {
          const isUser = msg.role === 'user';
          const previous = i > 0 ? messages[i - 1] : null;
          const showAssistantAvatar = !isUser && (!previous || previous.role !== 'assistant');

          return (
            <div key={`${msg.role}-${i}-${msg.content.slice(0, 20)}`}>
              <div className={`gzd-message-row ${isUser ? 'user' : 'assistant'}`}>
                {!isUser && (
                  <div className={`gzd-assistant-avatar ${showAssistantAvatar ? '' : 'placeholder'}`}>✦</div>
                )}
                <div className="gzd-bubble-wrap">
                  <div className={`gzd-bubble ${isUser ? 'user' : 'assistant'}`}>
                    {msg.content}
                    {debugMode && !isUser && msg.source && <div className="gzd-debug">{msg.source}</div>}
                  </div>
                  {!isUser && !msg.escalated && <CitationList citations={msg.citations} />}
                  <div className={`gzd-time ${isUser ? 'user' : 'assistant'}`}>{formatTime(msg.time)}</div>
                </div>
              </div>

              {!isUser && msg.escalated && !leadCaptured && !escalationSubmitted && (
                <form className="gzd-escalation" onSubmit={submitEscalationLead}>
                  <div className="gzd-escalation-title">✉️ Want a follow-up?</div>
                  <div className="gzd-escalation-sub">Leave your email and we&apos;ll get back to you.</div>
                  <div className="gzd-escalation-row">
                    <input
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
          <h3>Before we start...</h3>
          <p>Leave your details so we can follow up if needed.</p>
          <input
            placeholder="Your name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            type="email"
            placeholder="your@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <button type="submit">Start chatting →</button>
          <button className="gzd-gate-skip" type="button" onClick={skipLeadCapture}>Skip for now</button>
          {error && <p className="gzd-error">{error}</p>}
        </form>
      ) : (
        <>
          <form className="gzd-input-bar" onSubmit={sendMessage}>
            <input
              ref={inputRef}
              className="gzd-input"
              placeholder="Type your message..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <button className="gzd-send" type="submit" disabled={!message.trim()} aria-label="Send message">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M5 12H19" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M13 6L19 12L13 18" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </form>
          <div className="gzd-powered">⚡ Powered by Glazed</div>
          {error && <p className="gzd-error" style={{ margin: '0 16px 10px' }}>{error}</p>}
        </>
      )}
    </div>
  );
}
