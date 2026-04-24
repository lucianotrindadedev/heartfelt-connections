import { createFileRoute } from "@tanstack/react-router";
import { TrainingTab } from "@/components/account/TrainingTab";

export const Route = createFileRoute("/embed/account/$accountId/training")({
  component: () => {
    const { accountId } = Route.useParams();
    return <TrainingTab accountId={accountId} kind="main" />;
  },
});
