import { createFileRoute } from "@tanstack/react-router";
import { FollowupTab } from "@/components/account/FollowupTab";

export const Route = createFileRoute("/embed/account/$accountId/followup")({
  component: () => {
    const { accountId } = Route.useParams();
    return <FollowupTab accountId={accountId} />;
  },
});
