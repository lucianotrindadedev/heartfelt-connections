import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/embed/account/$accountId/")({
  component: () => {
    const { accountId } = Route.useParams();
    return (
      <Navigate
        to="/embed/account/$accountId/overview"
        params={{ accountId }}
        search={{}}
      />
    );
  },
});

