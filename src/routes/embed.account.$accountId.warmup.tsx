import { createFileRoute } from "@tanstack/react-router";
import { WarmupTab } from "@/components/account/WarmupTab";

export const Route = createFileRoute("/embed/account/$accountId/warmup")({
  component: () => {
    const { accountId } = Route.useParams();
    return <WarmupTab accountId={accountId} />;
  },
});
