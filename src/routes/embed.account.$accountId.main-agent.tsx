import { createFileRoute } from "@tanstack/react-router";
import { AgentEditor } from "@/components/account/AgentEditor";

export const Route = createFileRoute("/embed/account/$accountId/main-agent")({
  component: () => {
    const { accountId } = Route.useParams();
    return (
      <AgentEditor
        accountId={accountId}
        kind="main"
        emptyMessage="Esta conta ainda não tem agente principal. Use o painel Admin para criar."
      />
    );
  },
});
