import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/embed/account/$accountId")({
  component: AccountLayout,
});

function AccountLayout() {
  return <Outlet />;
}
