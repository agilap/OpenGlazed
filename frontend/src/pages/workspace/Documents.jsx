import DocumentLibrary from '../../components/DocumentLibrary';
export default function Documents({ workspace, id }) {
  return <section className="workspace-card workspace-card--padded"><DocumentLibrary businessId={id} tone="light" onUnauthorized={() => workspace.setNeedSignIn(true)} onDocuments={workspace.setDocuments}/></section>;
}
