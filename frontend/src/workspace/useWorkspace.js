import { useCallback, useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE || '';

export function useWorkspace(businessId) {
  const [business, setBusiness] = useState(null);
  const [stats, setStats] = useState({ documents: null, questionsAnswered: null, unansweredRate: null, medianLatencyMs: null, totalLeads: null });
  const [conversations, setConversations] = useState([]);
  const [leads, setLeads] = useState([]);
  const [documents, setDocumentState] = useState([]);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [needSignIn, setNeedSignIn] = useState(false);
  const [user, setUser] = useState(null);
  const [signedIn, setSignedIn] = useState(false);
  const [workspaces, setWorkspaces] = useState([]);
  const [inboxCounts, setInboxCounts] = useState({});

  const authedFetch = useCallback(async (url, options = {}) => {
    const response = await fetch(url, { ...options, credentials: 'include' });
    if (response.status === 401) setNeedSignIn(true);
    return response;
  }, []);
  const request = useCallback(async (path) => {
    const response = await authedFetch(`${API_BASE}${path}`);
    const json = await response.json();
    if (!response.ok || json.error) throw new Error(json.error || 'Failed to load workspace');
    return json;
  }, [authedFetch]);
  const setDocuments = useCallback((docs) => {
    setDocumentState(docs);
    setStats((current) => ({ ...current, documents: docs.filter((doc) => doc.status === 'ready').length }));
  }, []);
  const refreshDocuments = useCallback(async () => {
    const result = await request(`/api/sources/${businessId}`);
    setDocuments(Array.isArray(result.documents) ? result.documents : []);
    return result.documents;
  }, [businessId, request, setDocuments]);
  const reload = useCallback(async () => {
    if (!businessId) return;
    setError(null);
    setNeedSignIn(false);
    setStatus('loading');
    try {
      const [dashboard, nextStats, sessions, nextLeads, sources] = await Promise.all([
        request(`/api/businesses/${businessId}/dashboard`), request(`/api/dashboard/${businessId}/stats`),
        request(`/api/dashboard/${businessId}/sessions`), request(`/api/dashboard/${businessId}/leads`),
        request(`/api/sources/${businessId}`),
      ]);
      setBusiness(dashboard.business);
      setStats({ documents: nextStats.documents ?? null, questionsAnswered: nextStats.questionsAnswered ?? null, unansweredRate: nextStats.unansweredRate ?? null, medianLatencyMs: nextStats.medianLatencyMs ?? null, totalLeads: nextStats.totalLeads ?? null, offTopic: nextStats.offTopic ?? null });
      setConversations(Array.isArray(sessions) ? sessions : []);
      setLeads(Array.isArray(nextLeads) ? nextLeads : []);
      setDocuments(Array.isArray(sources.documents) ? sources.documents : []);
      setStatus('ready');
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  }, [businessId, request, setDocuments]);
  useEffect(() => {
    fetch(`${API_BASE}/api/auth/me`, { credentials: 'include' }).then(async (response) => {
      if (response.ok) { const data = await response.json(); setUser(data.user || data); setWorkspaces(data.businesses || []); setSignedIn(true); }
    }).catch(() => {});
  }, []);
  useEffect(() => { reload(); }, [reload, signedIn]);
  useEffect(() => { if (!businessId) return; let active = true; authedFetch(`${API_BASE}/api/inbox/${businessId}?status=unanswered&state=open`).then((r) => r.ok ? r.json() : null).then((data) => { if (active && data?.counts) setInboxCounts(data.counts); }).catch(() => {}); return () => { active = false; }; }, [businessId, authedFetch, signedIn]);
  return { business, stats, workspaces, inboxCounts, setInboxCounts, conversations, leads, documents, status, error, signedIn, user, needSignIn, setNeedSignIn, authedFetch, reload, refreshDocuments, setDocuments };
}
