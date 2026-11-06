import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import EmbeddableWidget from '../components/EmbeddableWidget';
import { widgetConfig } from '../widgetConfig';
import '../styles/account.css';

const API_BASE = import.meta.env.VITE_API_BASE || '';

export default function EmbedWidgetPage() {
  const { id } = useParams();
  const [name, setName] = useState('');
  const config = useMemo(() => widgetConfig(window.location.search), []);
  useEffect(() => {
    const controller = new AbortController();
    setName('');
    fetch(`${API_BASE}/api/businesses/${id}`, { signal: controller.signal }).then((response) => response.ok ? response.json() : null).then((data) => setName(data?.business?.name || '')).catch(() => {});
    return () => controller.abort();
  }, [id]);
  useEffect(() => {
    function close(event) {
      if (event.key === 'Escape' && window.parent !== window) window.parent.postMessage({ type: 'GLAZED_CLOSE' }, '*');
    }
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, []);
  return <div className="share-chat-page">
    <header className="share-chat-header"><a href="/">Glazed AI</a><span>{name ? `Answers from ${name}'s documents` : 'Answers from uploaded documents'}</span></header>
    <main className="share-chat-main"><EmbeddableWidget businessId={id} config={config} /></main>
  </div>;
}
