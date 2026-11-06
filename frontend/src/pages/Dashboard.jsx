import { Navigate, useParams } from 'react-router-dom';
import { useWorkspace } from '../workspace/useWorkspace';
import WorkspaceShell from '../components/WorkspaceShell';
import Overview from './workspace/Overview';
import Documents from './workspace/Documents';
import Conversations from './workspace/Conversations';
import Leads from './workspace/Leads';
import Traces from './workspace/Traces';
import Api from './workspace/Api';
import Embed from './workspace/Embed';

const views = { overview: Overview, documents: Documents, conversations: Conversations, leads: Leads, traces: Traces, api: Api, embed: Embed };
const descriptions = { documents: 'PDF, DOCX, Markdown, TXT, CSV or JSON, up to 18 MB each.' };
const titles = { overview: 'Overview', documents: 'Documents', conversations: 'Conversations', leads: 'Leads', traces: 'Traces', api: 'API', embed: 'Embed' };
export default function Dashboard() {
  const { id, view } = useParams();
  const workspace = useWorkspace(id);
  if (!views[view]) return <Navigate to={`/dashboard/${id}/overview`} replace />;
  const View = views[view];
  return <WorkspaceShell workspace={workspace} active={view} title={titles[view]} description={descriptions[view]} actions={view === 'overview' ? <Overview.Actions id={id} /> : null} fill={view === 'conversations'}>{workspace.status === 'loading' && !workspace.business ? <div className="workspace-skeletons" aria-label="Loading workspace"><div/><div/><div/></div> : <View workspace={workspace} id={id}/>}</WorkspaceShell>;
}
