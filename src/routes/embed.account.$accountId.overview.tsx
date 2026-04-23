import { createFileRoute } from "@tanstack/react-router";
import { OverviewTab } from "@/components/account/OverviewTab";

export const Route = createFileRoute("/embed/account/$accountId/overview")({
  component: () => {
    const { accountId } = Route.useParams();
    return <OverviewTab accountId={accountId} />;
  },
});
