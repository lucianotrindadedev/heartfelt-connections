import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/embed/$accountId")({
  component: function EmbedAccountRedirect() {
    const { accountId } = Route.useParams();
    throw redirect({
      to: "/embed/account/$accountId",
      params: { accountId },
    });
  },
});