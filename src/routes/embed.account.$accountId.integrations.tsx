import { createFileRoute } from "@tanstack/react-router";
import { IntegrationsTab } from "@/components/account/IntegrationsTab";

export const Route = createFileRoute("/embed/account/$accountId/integrations")({
  component: () => {
    const { accountId } = Route.useParams();
    return <IntegrationsTab accountId={accountId} />;
  },
});
