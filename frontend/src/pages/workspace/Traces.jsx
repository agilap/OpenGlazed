import TracePanel from '../../components/TracePanel';
export default function Traces({ workspace, id }) { return <TracePanel key={id} businessId={id} adminToken={workspace.adminToken} onUnauthorized={() => workspace.setNeedToken(true)}/>; }
