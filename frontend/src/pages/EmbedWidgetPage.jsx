import { useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import EmbeddableWidget from '../components/EmbeddableWidget';
import { widgetConfig } from '../widgetConfig';

export default function EmbedWidgetPage() {
  const { id } = useParams();
  const config = useMemo(() => widgetConfig(window.location.search), []);
  useEffect(() => {
    function close(event) {
      if (event.key === 'Escape' && window.parent !== window) window.parent.postMessage({ type: 'GLAZED_CLOSE' }, '*');
    }
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, []);
  return <div style={{ width: '100%', height: '100dvh', margin: 0, overflow: 'hidden' }}>
    <EmbeddableWidget businessId={id} config={config} />
  </div>;
}
