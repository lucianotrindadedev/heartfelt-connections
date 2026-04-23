import { createFileRoute } from "@tanstack/react-router";
import { LogsTab } from "@/components/account/LogsTab";

export const Route = createFileRoute("/embed/account/$accountId/logs")({
  component: () => {
    const { accountId } = Route.useParams();
    return <LogsTab accountId={accountId} />;
  },
});
