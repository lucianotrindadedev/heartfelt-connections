import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Conversation, Message } from "@/lib/types";

export function ConversationsTab({ accountId }: { accountId: string }) {
  const list = useQuery({
    queryKey: ["conversations", accountId],
    queryFn: () =>
      api<Conversation[]>(`/api/accounts/${accountId}/conversations`),
  });

  const [selected, setSelected] = useState<string | null>(null);
  const messages = useQuery({
    queryKey: ["messages", selected],
    queryFn: () => api<Message[]>(`/api/conversations/${selected}/messages`),
    enabled: !!selected,
  });

  return (
    <div className="grid gap-4 md:grid-cols-[300px_1fr]">
      <aside className="rounded-lg border border-border bg-card">
        {list.isLoading && (
          <p className="p-3 text-sm text-muted-foreground">Carregando…</p>
        )}
        {list.data?.length === 0 && (
          <p className="p-3 text-sm text-muted-foreground">Nenhuma conversa.</p>
        )}
        <ul className="divide-y divide-border">
          {list.data?.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => setSelected(c.id)}
                className={
                  selected === c.id
                    ? "block w-full bg-secondary px-3 py-2 text-left text-sm"
                    : "block w-full px-3 py-2 text-left text-sm hover:bg-accent"
                }
              >
                <p className="font-medium">{c.phone}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(c.updated_at).toLocaleString()} · {c.status}
                </p>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="rounded-lg border border-border bg-card">
        {!selected && (
          <p className="p-4 text-sm text-muted-foreground">
            Selecione uma conversa.
          </p>
        )}
        {selected && messages.isLoading && (
          <p className="p-4 text-sm text-muted-foreground">Carregando…</p>
        )}
        {messages.data && (
          <div className="space-y-2 p-3">
            {messages.data.map((m) => (
              <div
                key={m.id}
                className={
                  m.role === "assistant"
                    ? "ml-auto max-w-[80%] rounded-lg bg-primary p-2.5 text-sm text-primary-foreground"
                    : m.role === "tool"
                      ? "max-w-[80%] rounded-lg border border-dashed border-border bg-muted p-2.5 text-xs"
                      : "max-w-[80%] rounded-lg bg-secondary p-2.5 text-sm text-secondary-foreground"
                }
              >
                <p className="text-[10px] uppercase opacity-70">{m.role}</p>
                <p className="whitespace-pre-wrap">{m.content}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
