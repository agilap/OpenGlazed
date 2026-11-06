import { Routes, Route, Navigate, useParams } from 'react-router-dom';
import Onboarding from './pages/Onboarding';
import Dashboard from './pages/Dashboard';
import EmbedWidgetPage from './pages/EmbedWidgetPage';
import TeamChat from './pages/TeamChat';
import Account from './pages/Account';
import NewWorkspace from './pages/NewWorkspace';

function DashboardRedirect() {
  const { id } = useParams();
  return <Navigate to={`/dashboard/${id}/overview`} replace />;
}
export default function App() {
  return <div className="app-shell"><Routes><Route path="/workspaces/new" element={<NewWorkspace />} /><Route path="/account" element={<Account />} /><Route path="/login" element={<Account mode="login" />} /><Route path="/signup" element={<Account mode="signup" />} /><Route path="/" element={<Onboarding />} /><Route path="/dashboard/:id" element={<DashboardRedirect />} /><Route path="/dashboard/:id/:view" element={<Dashboard />} /><Route path="/embed/:id" element={<EmbedWidgetPage />} /><Route path="/team/:id" element={<TeamChat />} /></Routes></div>;
}
