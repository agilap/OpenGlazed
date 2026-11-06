import { useState } from 'react';
import Icon from '../../components/Icon';
export default function Embed({ id }) {
  const [copied, setCopied] = useState(false);
  const snippet = `<script src="/widget.js" data-business-id="${id}"></script>`;
  async function copy() { try { await navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); } }
  return <div className="workspace-embed-grid"><section className="workspace-card workspace-card--padded"><h2>Embed code</h2><p>Add this snippet to your website.</p><pre>{snippet}</pre><div className="workspace-embed-actions"><button className="workspace-button workspace-button--primary" type="button" onClick={copy}><Icon name={copied ? 'check' : 'copy'}/>{copied ? 'Copied' : 'Copy snippet'}</button><a className="workspace-button" href={`/embed/${id}`} target="_blank" rel="noreferrer">Open shareable chat <Icon name="external"/></a></div></section><section className="workspace-preview"><iframe title="Chat preview" src={`/embed/${id}`}/></section></div>;
}
