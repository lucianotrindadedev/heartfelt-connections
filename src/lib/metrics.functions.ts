// Painel de métricas do agente (embed do cliente).
//
// Mesma exposição das outras funções do embed: sem middleware de auth, tudo
// escopado pelo accountId que já está na URL do iframe dentro do CRM.
//
// Este arquivo é só a casca RPC: a leitura no banco está em
// @/lib/metrics/load.server e a conta em @/lib/metrics/aggregate (puro).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { loadAgentMetrics } from "@/lib/metrics/load.server";

export const getAgentMetrics = createServerFn({ method: "GET" })
  .inputValidator((d) =>
    z
      .object({
        accountId: z.string().min(1),
        days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30),
      })
      .parse(d),
  )
  .handler(async ({ data }) => loadAgentMetrics(data.accountId, data.days));
