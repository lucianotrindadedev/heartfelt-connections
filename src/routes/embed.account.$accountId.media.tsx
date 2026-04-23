import { createFileRoute } from "@tanstack/react-router";
import { MediaTab } from "@/components/account/MediaTab";

export const Route = createFileRoute("/embed/account/$accountId/media")({
  component: () => {
    const { accountId } = Route.useParams();
    return <MediaTab accountId={accountId} />;
  },
});
