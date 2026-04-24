import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/embed/$accountId")({
  component: function EmbedAccountRedirect() {
    throw redirect({
      to: "/embed/account/$accountId",
      params: (r) => ({ accountId: r.accountId }),
    });
  },
});