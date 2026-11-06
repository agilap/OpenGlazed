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
  const [adminToken, setAdminToken] = useState(() => localStorage.getItem('glazed_admin_token') || '');
  const [needToken, setNeedToken] = useState(false);
  const [user, setUser] = useState(null);
  const [signedIn, setSignedIn] = useState(false);

  const saveToken = useCallback((token) => {
    setAdminToken(token);
    if (token) localStorage.setItem('glazed_admin_token', token);
    else localStorage.removeItem('glazed_admin_token');
  }, []);
  const authedFetch = useCallback(async (url, options = {}) => {
    const headers = new Headers(options.headers || {});
    if (adminToken) headers.set('Authorization', `Bearer ${adminToken}`);
    const response = await fetch(url, { ...options, headers, credentials: 'include' });
    if (response.status === 401) setNeedToken(true);
    return response;
  }, [adminToken]);
  const request = useCallback(async (path, authenticated = true) => {
    const response = await (authenticated ? authedFetch(`${API_BASE}${path}`) : fetch(`${API_BASE}${path}`));
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
    setNeedToken(false);
    setStatus('loading');
    try {
      const [dashboard, nextStats, sessions, nextLeads, sources, ingest] = await Promise.all([
        request(`/api/businesses/${businessId}/dashboard`), request(`/api/dashboard/${businessId}/stats`),
        request(`/api/dashboard/${businessId}/sessions`), request(`/api/dashboard/${businessId}/leads`),
        request(`/api/sources/${businessId}`), request(`/api/ingest/${businessId}/status`, false),
      ]);
      setBusiness({ ...dashboard.business, ingest_status: ingest.status, ingest_progress: ingest.ingest_progress });
      setStats({ documents: nextStats.documents ?? null, questionsAnswered: nextStats.questionsAnswered ?? null, unansweredRate: nextStats.unansweredRate ?? null, medianLatencyMs: nextStats.medianLatencyMs ?? null, totalLeads: nextStats.totalLeads ?? null });
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
      if (response.ok) { const data = await response.json(); setUser(data.user || data); setSignedIn(true); }
    }).catch(() => {});
  }, []);
  useEffect(() => { reload(); }, [reload, signedIn]);
  useEffect(() => {
    if (!businessId) return undefined;
    const timer = setInterval(() => {
      request(`/api/ingest/${businessId}/status`, false).then((ingest) => setBusiness((current) => current ? { ...current, ingest_status: ingest.status, ingest_progress: ingest.ingest_progress } : current)).catch(() => {});
      refreshDocuments().catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [businessId, request, refreshDocuments]);
  return { business, stats, conversations, leads, documents, status, error, adminToken, saveToken, signedIn, user, needToken, setNeedToken, authedFetch, reload, refreshDocuments, setDocuments };
}
