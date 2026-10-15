import { createFileRoute } from '@tanstack/react-router';
import { ShortIssueLinkPage } from '@/pages/short-link/ShortIssueLinkPage';

// Short issue links: /bdb-6 (case-insensitive) → full issue URL.
// Static top-level routes (/workspaces, /onboarding, /export, ...) take
// precedence over this dynamic segment in TanStack Router.
function ShortKeyRouteComponent() {
  const { shortKey } = Route.useParams();
  return <ShortIssueLinkPage shortKey={shortKey} />;
}

export const Route = createFileRoute('/$shortKey')({
  component: ShortKeyRouteComponent,
});
