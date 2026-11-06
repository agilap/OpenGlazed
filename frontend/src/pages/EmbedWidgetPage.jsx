import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import EmbeddableWidget from '../components/EmbeddableWidget';
import { widgetConfig } from '../widgetConfig';
import '../styles/account.css';

const API_BASE = import.meta.env.VITE_API_BASE || '';

export default function EmbedWidgetPage() {
  const { id } = useParams();
  const [business, setBusiness] = useState(null);
  const name = business?.name || ''; 
  const config = useMemo(() => { const params = new URLSearchParams(window.location.search); const parsed = widgetConfig(window.location.search); return { ...parsed, greeting: params.has('greeting') ? parsed.greeting : business?.greeting || '', color: params.has('color') ? parsed.color : business?.accent_color || parsed.color }; }, [business]);
  useEffect(() => {
    const controller = new AbortController();
    setBusiness(null);
    fetch(`${API_BASE}/api/businesses/${id}`, { signal: controller.signal }).then((response) => response.ok ? response.json() : null).then((data) => setBusiness(data?.business || null)).catch(() => {});
    return () => controller.abort();
  }, [id]);
  useEffect(() => {
    if (business?.accent_color && window.parent !== window) window.parent.postMessage({ type: 'GLAZED_THEME', color: business.accent_color }, '*');
  }, [business]);
  useEffect(() => {
    function close(event) {
      if (event.key === 'Escape' && window.parent !== window) window.parent.postMessage({ type: 'GLAZED_CLOSE' }, '*');
    }
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, []);
  if (new URLSearchParams(window.location.search).get('mode') === 'widget') {
    return <div className="share-chat-bare"><EmbeddableWidget businessId={id} config={config} /></div>;
  }
  return <div className="share-chat-page">
    <header className="share-chat-header"><a href="/">Glazed AI</a><span>{name ? `Answers from ${name}'s documents` : 'Answers from uploaded documents'}</span></header>
    <main className="share-chat-main"><EmbeddableWidget businessId={id} config={config} /></main>
  </div>;
}
