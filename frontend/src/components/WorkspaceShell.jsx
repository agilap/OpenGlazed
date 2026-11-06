import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import AdminTokenForm from './AdminTokenForm';
import Icon from './Icon';
import '../styles/workspace.css';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const groups = [['Workspace', [['overview', 'Overview'], ['documents', 'Documents'], ['conversations', 'Conversations'], ['inbox', 'Inbox'], ['leads', 'Leads'], ['team', 'Team chat']]], ['Configure', [['traces', 'Traces'], ['api', 'API'], ['embed', 'Embed'], ['settings', 'Settings']]]];

function WorkspaceSwitcher({ workspace, state }) {
  const [open, setOpen] = useState(false); const root = useRef(null); const trigger = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    root.current?.querySelector('[role="menuitem"]')?.focus();
    function key(e) {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); trigger.current?.focus(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const links = Array.from(root.current?.querySelectorAll('[role="menuitem"]') || []); const index = links.indexOf(document.activeElement); links[(index + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length]?.focus(); }
      if (e.key === 'Tab') setOpen(false);
    }
    function outside(e) { if (!root.current?.contains(e.target)) setOpen(false); }
    document.addEventListener('keydown', key); document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside); };
  }, [open]);
  return <div className="workspace-identity" ref={root}>{workspace.signedIn ? <><button ref={trigger} className="workspace-switcher-trigger" type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><strong>{workspace.business?.name || 'Workspace'}</strong><Icon name="chevrons-up-down"/></button>{open && <div className="workspace-switcher-menu" role="menu">{workspace.workspaces.map((business) => <Link role="menuitem" key={business.id} to={`/dashboard/${business.id}/overview`} onClick={() => setOpen(false)}><span><strong>{business.name}</strong>{business.document_count != null && <small>{business.document_count} ready documents</small>}</span>{Number(business.open_unanswered) > 0 && <span className="workspace-badge">{business.open_unanswered} unanswered</span>}</Link>)}<Link role="menuitem" to="/workspaces/new" onClick={() => setOpen(false)}>New workspace</Link><Link role="menuitem" to="/account" onClick={() => setOpen(false)}>All workspaces</Link></div>}</> : <strong>{workspace.business?.name || 'Workspace'}</strong>}{state !== 'ready' && <span><i className={`workspace-dot workspace-dot--${state}`}/>{state}</span>}</div>;
}

export default function WorkspaceShell({ workspace, active, title, description, actions, fill = false, children }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const sheet = useRef(null);
  const menu = useRef(null);
  const ready = workspace.documents.filter((doc) => doc.status === 'ready').length;
  const indexing = workspace.documents.some((doc) => ['queued', 'processing'].includes(doc.status));
  const state = indexing ? 'indexing' : workspace.documents.some((doc) => doc.status === 'error') ? 'error' : ready ? 'ready' : 'empty';
  useEffect(() => { setOpen(false); }, [location]);
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    sheet.current?.querySelector('button, a')?.focus();
    function onKey(event) {
      if (event.key === 'Escape') { setOpen(false); return; }
      if (event.key !== 'Tab') return;
      const items = Array.from(sheet.current.querySelectorAll('a[href], button:not([disabled])'));
      if (!items.length) return;
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus(); }
    }
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [open]);
  async function signOut() {
    await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', credentials: 'include' });
    navigate('/login');
  }
  const nav = <><div className="workspace-sidebar-top"><Link className="workspace-wordmark" to={workspace.signedIn ? '/account' : '/'}>Glazed AI</Link><button className="workspace-sheet-close" type="button" aria-label="Close menu" onClick={() => setOpen(false)}><Icon name="x" size={20}/></button></div><WorkspaceSwitcher workspace={workspace} state={state}/><nav aria-label="Workspace navigation">{groups.map(([group, items]) => <div className="workspace-nav-group" key={group}><div className="workspace-nav-label">{group}</div>{items.map(([key, label]) => { const badge = key === 'documents' ? ready : key === 'conversations' ? workspace.conversations.filter((item) => item.escalated).length : key === 'inbox' ? Number(workspace.inboxCounts?.unanswered || 0) : 0; return <NavLink key={key} to={key === 'team' ? `/team/${id}` : `/dashboard/${id}/${key}`} className={() => `workspace-nav-item${active === key ? ' is-active' : ''}`} aria-current={active === key ? 'page' : undefined}><Icon name={key}/><span>{label}</span>{badge > 0 && <span className="workspace-badge">{badge}</span>}</NavLink>; })}</div>)}</nav><div className="workspace-footer">{workspace.signedIn ? <><span title={workspace.user?.email}>{workspace.user?.email}</span><button type="button" onClick={signOut}><Icon name="logout"/>Sign out</button><Link to="/account">All workspaces</Link></> : <div className="workspace-admin-access"><span><Icon name="api" size={14}/>Admin access</span><Link to="/login">Sign in</Link></div>}</div></>;
  return <div className="workspace-shell"><a className="workspace-skip" href="#content">Skip to content</a><aside className="workspace-sidebar">{nav}</aside><div className="workspace-mobile-bar"><Link className="workspace-wordmark" to={workspace.signedIn ? '/account' : '/'}>Glazed AI</Link><span>{workspace.business?.name || 'Workspace'}</span><button ref={menu} type="button" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}><Icon name="menu" size={22}/></button></div>{open && <div className="workspace-sheet" role="dialog" aria-modal="true" aria-label="Workspace menu" ref={sheet}>{nav}</div>}<div className="workspace-body"><header className="workspace-header"><div><div className="workspace-kicker">{workspace.business?.name || 'Workspace'} / {title}</div><h1>{title}</h1>{description && active !== 'documents' && <p>{description}</p>}</div>{actions && <div className="workspace-header-actions">{actions}</div>}</header><main id="content" tabIndex="-1" className={`workspace-content${fill ? ' workspace-content--fill' : ''}`}>{workspace.needToken && !workspace.signedIn && <AdminTokenForm id="dashboard-admin-token" label="This dashboard is protected. Paste your ADMIN_TOKEN." initialToken={workspace.adminToken} rejected={workspace.needToken && Boolean(workspace.adminToken)} onSubmit={(value) => value === workspace.adminToken ? workspace.reload() : workspace.saveToken(value)}/>} {workspace.error && !workspace.needToken && <div className="workspace-error" role="alert">{workspace.error} <button type="button" onClick={workspace.reload}>Try again</button></div>}{children}</main></div></div>;
}
