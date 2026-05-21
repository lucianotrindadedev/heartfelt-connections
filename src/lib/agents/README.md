# Multi-Agent Architecture

Substitui o agente monolítico (`agent-turn.server.ts` antigo, 1262 linhas) por
uma **máquina de estados com sub-agentes especializados**.

## Por que

O agente único:
- Carregava 14k tokens de prompt com 8 responsabilidades
- Decidia "por intuição" quando agendar — alucinava
- Esquecia o nome do paciente (history poisoning)
- Misturava persona com lógica de tool calling

A nova arquitetura:
- **Cada sub-agente tem 1 responsabilidade e ~1.5k tokens de prompt focado**
- **Estado é estruturado** em `conversations.meta.lead_data` (jsonb) — não depende
  da memória da LLM
- **Transições são validadas** em código (`resolveNextStage`), não pela LLM
- **Tools são gateadas** por stage — Scheduler vê Clinicorp, Qualifier não

## Stages

```
RECEPTION ──▶ QUALIFICATION ──▶ SLOT_OFFER ──▶ NAME_COLLECT ──▶ BOOKING ──▶ CONFIRMED
    │             │                 │                                          │
    └─────────────┴─────────────────┴──────────────────────────────────────────┘
                                    │
                                    ▼
                              ESCALATED (terminal)
```

Definidos em `stage.ts`. Transições válidas no objeto `TRANSITIONS` —
pulos ilegais são bloqueados silenciosamente.

## Sub-Agentes

| Agente | Stages | Tools | Prompt |
|---|---|---|---|
| **Qualifier** (`qualifier.server.ts`) | RECEPTION, QUALIFICATION | `aplicar_tag_interesse` | SPIN + UTM + persona |
| **Scheduler** (`scheduler.server.ts`) | SLOT_OFFER, NAME_COLLECT, BOOKING, CONFIRMED | `buscar_paciente`, `listar_horarios`, `criar_agendamento` | Booking determinístico |

Roteamento em `routeForStage(stage)`.

## LeadData

Scratch pad estruturado entre turns. Substitui a "memória" da LLM:

```ts
interface LeadData {
  name?: string;
  interest?: string;
  selected_slot_iso?: string;
  dentist_person_id?: number;
  offered_slots?: { iso, date_label, time_label, dentist_person_id }[];
  appointment_id?: number | string;
  commitment_confirmed?: boolean;
  patient_id?: number;
  notes?: string;
  escalation_reason?: string;
}
```

Cada sub-agente lê o estado e propõe um **patch parcial** (`lead_data_patch`).
O orchestrator faz o merge e persiste em `conversations.meta.lead_data`.

## Output estruturado

Cada sub-agente DEVE retornar JSON conforme schema (validado com zod):

```json
{
  "reply": "texto para o lead",
  "next_stage": "QUALIFICATION",
  "lead_data_patch": { "interest": "IMPLANTE" },
  "reasoning": "1 frase para logging"
}
```

## Prompt Caching (Anthropic)

`llm.server.ts` ativa `cache_control: { type: "ephemeral" }` no system prompt
estático (persona, regras, settings da clínica) quando o modelo é
`anthropic/*`. Só o `systemDynamic` (data atual, lead_data) vai sem cache.

Resultado típico em conversas longas:
- ~90% do prompt cacheado
- ~80% menos custo
- ~30% menos latência

## Fluxo do Orchestrator

```
runAgentTurn(conversationId)
  │
  ├─ load conversation + agent + settings + secrets
  ├─ acquire lock (com stale recovery)
  ├─ load history (filtra meta.fallback)
  ├─ load contato Helena
  ├─ load stage + lead_data de conversations.meta
  ├─ load integrations habilitadas
  │
  ├─ ctx = AgentContext { ... }
  ├─ route = routeForStage(stage)
  │
  ├─ if qualifier  → runQualifierAgent(ctx)
  ├─ if scheduler  → runSchedulerAgent(ctx)
  ├─ if escalation → silencia
  │
  ├─ resolveNextStage(stage, result.next_stage)
  ├─ merge lead_data
  ├─ persist conversations.meta
  ├─ deliver reply (split + helena send)
  ├─ log agent_run
  │
  └─ se ESCALATED novo → escalateToHuman (tag + alerta)
```

## Adicionando um novo sub-agente

1. Adicionar stage(s) em `stage.ts` (`STAGES`, `TRANSITIONS`)
2. Atualizar `routeForStage` se o roteamento for novo
3. Criar arquivo `<nome>.server.ts` exportando `run<Nome>Agent(ctx): Promise<AgentResult>`
4. Plugar no `orchestrator.server.ts` (dispatch)
