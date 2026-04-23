import { createFileRoute } from "@tanstack/react-router";
import { AutomationsTab } from "@/components/account/AutomationsTab";

export const Route = createFileRoute("/embed/account/$accountId/automations")({
  component: () => {
    const { accountId } = Route.useParams();
    return <AutomationsTab accountId={accountId} />;
  },
});
