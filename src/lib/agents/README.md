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
| **Qualifier** (`qualifier.server.ts`) | RECEPTION, QUALIFICATION | `aplicar_tag_interesse`, `enviar_midia`, `listar_horarios`¹ | SPIN + UTM + persona |
| **Scheduler** (`scheduler.server.ts`) | SLOT_OFFER, NAME_COLLECT, BOOKING, CONFIRMED | `buscar_paciente`, `listar_horarios`, `criar_agendamento`, `cancelar_agendamento`, `remarcar_agendamento` | Booking determinístico |

¹ Só quando a conta tem agenda ativa, e **somente leitura** — ver "O ponto de costura" abaixo.

Roteamento em `routeForStage(stage)`.

## O ponto de costura (qualifier ↔ scheduler)

A troca entre os dois agentes é decidida por **heurística de texto em
português** (`stage-signals.ts`), que erra sempre que uma conta escreve o CTA de
um jeito novo. Quando errava, quem respondia era um agente **sem a ferramenta
necessária** — o qualifier prometia "vou verificar a agenda" e nunca voltava.
Custou 6 correções no mesmo ponto (`c01a675`, `8832ccc`, `96f9fda`, `e41baeb`,
`9a28fad` e o caso MF Beauty Magé de 28/07).

Duas defesas estruturais, além das heurísticas:

1. **Qualifier enxerga a agenda** (`listar_horarios`, read-only). Um repasse
   perdido degrada para "horário real um turno antes do previsto" em vez de
   "lead sem resposta útil". Criar/cancelar/remarcar seguem exclusivos do
   scheduler.
2. **Repasse no mesmo turn** (`orchestrator.server.ts`). Quando o qualifier
   decide que é hora de agendar — ou enrola prometendo agenda — o scheduler roda
   **em cascata no mesmo turn** e é a resposta dele que vai ao lead. Antes o
   turn acabava ali e o lead perdia uma rodada inteira. Não dispara quando o
   qualifier já trouxe horário real (evita a segunda chamada de LLM).
   Telemetria: `messages.meta.same_turn_handoff` (`"next_stage"` ou `"stall"`).

## Modo unificado (`agent_mode = "unified"`)

Flag **por conta** em `agents.settings.agent_mode` (jsonb livre — sem migration),
com toggle no painel do agente. Padrão: `staged` (fluxo dividido acima).

Em `unified`, **um só agente conduz da saudação ao agendamento**: o orquestrador
roteia todos os stages para o `scheduler`, que ganha os estágios de qualificação
(`UNIFIED_VALID_STAGES`), o campo `interest` no patch e a tool
`aplicar_tag_interesse`. Some a classe inteira de bug de transição — não há para
quem repassar.

Implementado **dentro do scheduler**, não num arquivo novo, de propósito: toda a
máquina de agendamento (auto-seleção de slot, agendamento determinístico, travas
de confirmação falsa, classificação de falha, telemetria) vive lá. Um segundo
agente seria uma cópia que divergiria na primeira correção feita só de um lado.

Duas condições, verificadas no orquestrador (a flag é ignorada com log se
falharem):

- **Exige agenda ativa** — sem tools de agendamento o prompt unificado recairia
  no mesmo "agente sem agenda inventando fluxo de agendamento" que
  `clampStageForBooking` existe para evitar.
- **Não vale para contas com classificador de turma** (`turma_auto`) — lá a tag
  de turma é aplicada deterministicamente dentro do qualifier
  (`applyTurmaTagDeterministic`, calculada da data de nascimento). Em modo
  unificado o qualifier não roda e a turma nunca seria etiquetada. Portar essa
  lógica é pré-requisito para migrar essas contas.

**O que o modo unificado NÃO resolve:** alucinação de agendamento ("marquei" sem
ter marcado), horário fora do expediente, paciente duplicado. Essas travas são
determinísticas, vivem no executor da tool e continuam valendo nos dois modos.

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
