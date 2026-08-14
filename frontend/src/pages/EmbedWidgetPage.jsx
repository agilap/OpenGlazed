import { useParams } from 'react-router-dom';
import EmbeddableWidget from '../components/EmbeddableWidget';

export default function EmbedWidgetPage() {
  const { id } = useParams();

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        margin: 0,
        padding: 0,
        overflow: 'hidden',
        background: '#ffffff',
      }}
    >
      <EmbeddableWidget businessId={id} />
    </div>
  );
}
