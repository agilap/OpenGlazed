import DocumentLibrary from '../../components/DocumentLibrary';
export default function Documents({ workspace, id }) {
  return <section className="workspace-card workspace-card--padded"><DocumentLibrary businessId={id} adminToken={workspace.adminToken} tone="light" onUnauthorized={() => workspace.setNeedToken(true)} onDocuments={workspace.setDocuments}/></section>;
}
