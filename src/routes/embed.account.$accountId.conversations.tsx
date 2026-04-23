import { createFileRoute } from "@tanstack/react-router";
import { ConversationsTab } from "@/components/account/ConversationsTab";

export const Route = createFileRoute("/embed/account/$accountId/conversations")({
  component: () => {
    const { accountId } = Route.useParams();
    return <ConversationsTab accountId={accountId} />;
  },
});
