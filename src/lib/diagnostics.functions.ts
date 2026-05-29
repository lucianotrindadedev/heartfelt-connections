// Diagnóstico do servidor para o painel admin (somente superadmin).
//  - Uso de RAM/CPU do VPS (visto pelo processo Node / host)
//  - Tamanho do banco e das maiores tabelas (via RPCs admin_*)
//  - Consumo agregado por conta (conversas, mensagens, turns, custo)

import { createServerFn } from "@tanstack/react-start";
import os from "node:os";
import { attachSelfhostAuth } from "@/integrations/selfhost/auth-attacher";
import { requireSuperAdmin } from "@/integrations/selfhost/auth-middleware";
import { getSelfhost } from "@/integrations/selfhost/client.server";

export interface TableSize {
  table_name: string;
  total_bytes: number;
  total_pretty: string;
  row_estimate: number;
}

export interface SystemDiagnostics {
  vps: {
    cpu_cores: number;
    load_1m: number;
    load_5m: number;
    load_15m: number;
    mem_total_bytes: number;
    mem_free_bytes: number;
    mem_used_bytes: number;
    process_rss_bytes: number;
    process_heap_used_bytes: number;
    uptime_seconds: number;
    node_version: string;
  };
  db: {
    total_bytes: number;
    tables: TableSize[];
  };
}

export const getSystemDiagnostics = createServerFn({ method: "GET" })
  .middleware([attachSelfhostAuth, requireSuperAdmin])
  .handler(async (): Promise<SystemDiagnostics> => {
    const sb = getSelfhost();

    const totalmem = os.totalmem();
    const freemem = os.freemem();
    const load = os.loadavg();
    const mu = process.memoryUsage();

    const [dbSizeRes, tablesRes] = await Promise.all([
      sb.rpc("admin_db_size"),
      sb.rpc("admin_table_sizes"),
    ]);

    const dbBytes =
      typeof dbSizeRes.data === "number"
        ? dbSizeRes.data
        : Number(dbSizeRes.data ?? 0);

    return {
      vps: {
        cpu_cores: os.cpus().length,
        load_1m: load[0] ?? 0,
        load_5m: load[1] ?? 0,
        load_15m: load[2] ?? 0,
        mem_total_bytes: totalmem,
        mem_free_bytes: freemem,
        mem_used_bytes: totalmem - freemem,
        process_rss_bytes: mu.rss,
        process_heap_used_bytes: mu.heapUsed,
        uptime_seconds: Math.round(process.uptime()),
        node_version: process.version,
      },
      db: {
        total_bytes: dbBytes,
        tables: (tablesRes.data as TableSize[] | null) ?? [],
      },
    };
  });

export interface AccountUsageRow {
  account_id: string;
  nome: string;
  conversations: number;
  messages: number;
  agent_runs: number;
  cost_usd: number;
  last_activity: string | null;
}

export const getAccountUsage = createServerFn({ method: "GET" })
  .middleware([attachSelfhostAuth, requireSuperAdmin])
  .handler(async (): Promise<{ accounts: AccountUsageRow[] }> => {
    const sb = getSelfhost();
    const { data, error } = await sb.rpc("admin_account_usage");
    if (error) throw new Error(error.message);
    return { accounts: (data ?? []) as AccountUsageRow[] };
  });
