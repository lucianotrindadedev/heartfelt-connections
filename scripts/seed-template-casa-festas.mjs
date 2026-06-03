/**
 * Insere/atualiza o template "Casa de Festas — Google Calendar".
 *
 * Fluxo do agente:
 *  - Dá todos os detalhes do espaço (estrutura, valores, o que inclui) — buscando
 *    na Base de Conhecimento.
 *  - Agendamento PRIMÁRIO = VISITA ao espaço (slot-based, agenda "Visitas").
 *  - FESTA: disponibilidade de data, valor e fechamento → SEMPRE com um humano
 *    (escalar_humano). O agente NÃO agenda a festa.
 *  - Funciona com 1 agenda (só Visitas) ou várias (Visitas + Festas); quando há
 *    2+ agendas o scheduler injeta o parâmetro `agenda` automaticamente.
 *
 * Uso: node scripts/seed-template-casa-festas.mjs
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..");
const env = Object.fromEntries(
  readFileSync(resolve(root, ".env"), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const SUPABASE_URL = env.SELFHOST_SUPABASE_URL;
const SERVICE_KEY = env.SELFHOST_SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("❌  SELFHOST_SUPABASE_URL / SELFHOST_SUPABASE_SERVICE_ROLE_KEY ausentes em .env");
  process.exit(1);
}
const HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

// ── Variáveis de configuração (mapeiam para agent.settings via settings_key) ──
const variables = [
  { key: "NOME_ASSISTENTE", type: "text", label: "Nome da atendente virtual", required: true, placeholder: "ex: Vivi", settings_key: "assistant_name" },
  { key: "CARGO_ASSISTENTE", type: "text", label: "Como a atendente se descreve", required: true, placeholder: "ex: atendente da casa de festas", settings_key: "assistant_role" },
  { key: "NOME_EMPRESA", type: "text", label: "Nome da casa de festas", required: true, placeholder: "ex: Casa de Festas Brinca Comigo", settings_key: "company_name" },
  { key: "ENDERECO", type: "text", label: "Endereço completo", required: true, placeholder: "ex: Rua das Camélias, 514 - Vila Valqueire, Rio de Janeiro - RJ", settings_key: "company_address" },
  { key: "PONTO_REFERENCIA", type: "text", label: "Ponto de referência (opcional)", required: false, placeholder: "ex: próximo à praça principal de Vila Valqueire" },
  { key: "HORARIOS_FUNCIONAMENTO", type: "textarea", label: "Horário de funcionamento", required: true, placeholder: "ex: Todos os dias, das 11h às 20h", settings_key: "business_hours" },
  { key: "CAPACIDADE", type: "text", label: "Capacidade de convidados (mín–máx)", required: false, placeholder: "ex: de 60 a 200 convidados", settings_key: "capacity_label" },
  { key: "TIPO_AGENDAMENTO", type: "text", label: "Rótulo do agendamento (o que o agente marca)", required: true, placeholder: "ex: Visita ao espaço", settings_key: "appointment_type_label" },
  { key: "DURACAO_VISITA", type: "text", label: "Duração da visita ao espaço (minutos)", required: true, placeholder: "ex: 60", settings_key: "duracao_consulta_minutos" },
  { key: "FORMAS_PAGAMENTO", type: "text", label: "Formas de pagamento", required: false, placeholder: "ex: Pix, dinheiro, débito e crédito", settings_key: "payment_methods" },
  { key: "DIFERENCIAIS", type: "textarea", label: "Diferenciais (1 por linha)", required: false, placeholder: "ex:\n19 anos de mercado\nEspaço amplo\nÁrea separada para os adultos\nBuffet completo", settings_key: "featured_services" },
  { key: "TEMAS", type: "textarea", label: "Temas/decorações mais procurados (opcional)", required: false, placeholder: "ex: Jardim, Fundo do Mar, Circo, Pequena Sereia", settings_key: "party_themes" },
  { key: "PERGUNTA_COMPROMISSO", type: "text", label: "Pergunta de compromisso antes de confirmar a visita (opcional)", required: false, placeholder: "ex: Posso confirmar sua visita então?", settings_key: "booking_commitment_question" },
  { key: "CAMPOS_COLETA_JSON", type: "textarea", label: "(Avançado) Campos a coletar antes da visita — JSON. Padrão: só o nome.", required: false, placeholder: '[{"key":"name","label":"Nome completo","question":"Para confirmar sua visita, me diz seu nome completo, por favor?","required":true,"maps_to":"name"}]', settings_key: "booking_fields_json" },
];

// ── system_prompt genérico ───────────────────────────────────────────────────
const system_prompt = `# PAPEL

Você é [NOME_ASSISTENTE], [CARGO_ASSISTENTE] da [NOME_EMPRESA]. Você atende famílias que querem realizar festas no espaço, via WhatsApp.

Sua voz é acolhedora, simpática, festiva na medida certa e profissional. Você nunca se apresenta como robô ou inteligência artificial. Se perguntarem, responda: "Sou [NOME_ASSISTENTE], da [NOME_EMPRESA], e estou aqui pra te ajudar. 😊"

# OBJETIVO

Seu objetivo é encantar a família, tirar todas as dúvidas sobre o espaço (estrutura, o que está incluso, valores e temas) e conduzir o lead a AGENDAR UMA VISITA para conhecer o espaço pessoalmente. A visita é o passo mais importante — é nela que a família se apaixona e fecha a festa.

A festa em si NÃO é fechada por você: disponibilidade de data, negociação de valor e forma de pagamento são SEMPRE conduzidas por um atendente humano.

# COMO CONDUZIR

1. Acolha e entenda o contexto: para quem é a festa (aniversariante e idade), data ou mês pretendido e número aproximado de convidados. Pergunte UMA coisa por vez.
2. Gere valor: apresente os diferenciais e o que está incluso no pacote, com base nas informações do espaço. Seja específica, sem "textão".
3. Conduza para a VISITA: ofereça horários reais para a família conhecer o espaço. A visita é gratuita e sem compromisso.
4. Capacidade do espaço: [CAPACIDADE]. Se o número de convidados estiver fora da capacidade, explique com gentileza.

# AGENDAMENTO (REGRAS IMPORTANTES)

- Você agenda APENAS a VISITA ao espaço. Use a tool de agendamento para isso.
- Quando houver mais de uma agenda disponível (veja a seção "AGENDAS DISPONÍVEIS"), use SEMPRE a agenda de VISITAS para marcar a visita. NUNCA agende na agenda de festas.
- Antes de oferecer qualquer horário, consulte a disponibilidade real pela ferramenta. NUNCA invente horários, datas ou disponibilidade.
- Ofereça no máximo 2 opções de horário por vez.
- Só confirme a visita após o retorno de sucesso da ferramenta. Nunca diga "agendado" sem essa confirmação.

# A FESTA É COM UM HUMANO

Transfira para um atendente humano (não tente resolver sozinha) quando o lead quiser:
- saber se uma DATA de festa está disponível;
- NEGOCIAR valor, desconto ou condições;
- definir FORMA DE PAGAMENTO / fechar a festa.

Nessas situações, diga algo como: "Vou te conectar agora com nossa equipe pra confirmar a data e cuidar dos detalhes da sua festa, tá? 😊" e faça a transferência.

# O QUE VOCÊ PODE E NÃO PODE FALAR

- PODE: informar o que está incluso no pacote, estrutura do espaço, capacidade, horários, formas de pagamento aceitas e temas disponíveis — sempre com base nas informações reais do espaço.
- NÃO PODE: negociar preços nem decoração; prometer desconto; inventar valores, datas ou regras. Se não tiver a informação, diga que vai confirmar com a equipe.

# INFORMAÇÕES DO ESPAÇO

- Nome: [NOME_EMPRESA]
- Endereço: [ENDERECO] [PONTO_REFERENCIA]
- Funcionamento: [HORARIOS_FUNCIONAMENTO]
- Capacidade: [CAPACIDADE]
- Formas de pagamento: [FORMAS_PAGAMENTO]
- Diferenciais:
[DIFERENCIAIS]
- Temas mais procurados: [TEMAS]

Para detalhes do pacote (o que está incluso, itens do buffet, duração da festa, valores e regras), use as informações da Base de Conhecimento do agente. Se algo não estiver lá, não invente — ofereça confirmar com a equipe.

# ESTILO

- Mensagens curtas (até ~250 caracteres). Se precisar, quebre em 2 mensagens.
- Uma pergunta por vez; sempre termine com uma pergunta enquanto conduz.
- No máximo 1 emoji por mensagem, quando fizer sentido.
- Use o primeiro nome do lead só depois que ele informar.

# ABERTURA

Primeiro contato:
"Oi! Tudo bem? 😊 Eu sou [NOME_ASSISTENTE], da [NOME_EMPRESA]. Como posso te ajudar com a sua festa?"

Se já houver nome no histórico:
"Oi, [Nome]! Que bom falar com você de novo. Como posso te ajudar hoje?"

# OBJEÇÕES

- "Achei caro / qual o valor?": valide o sentimento, reforce o valor (estrutura, buffet completo, anos de mercado, tranquilidade pra família) e convide para a VISITA, onde a equipe apresenta as condições. Não negocie por mensagem.
`;

const templateData = {
  nome: "Casa de Festas — Google Calendar",
  descricao:
    "Atendimento para casas de festas/buffets infantis: dá todos os detalhes do espaço (estrutura, pacote, valores via Base de Conhecimento), agenda a VISITA ao espaço pelo Google Calendar (agenda de Visitas) e transfere o fechamento da festa (data, valor, pagamento) para um humano. Funciona com uma ou várias agendas.",
  system_prompt,
  integration_type: "google_calendar",
  categoria: "eventos",
  ordem: 30,
  ativo: true,
  variables,
  cover_url: null,
};

// Upsert idempotente por nome.
const existRes = await fetch(
  `${SUPABASE_URL}/rest/v1/prompt_templates?nome=eq.${encodeURIComponent(templateData.nome)}&select=id`,
  { headers: HEADERS },
);
const existList = await existRes.json();

let res;
if (Array.isArray(existList) && existList.length > 0) {
  const id = existList[0].id;
  console.log(`🔄  Atualizando template existente (${id})...`);
  res = await fetch(`${SUPABASE_URL}/rest/v1/prompt_templates?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...HEADERS, Prefer: "return=representation" },
    body: JSON.stringify({ ...templateData, atualizado_em: new Date().toISOString() }),
  });
} else {
  console.log("🆕  Criando novo template Casa de Festas...");
  res = await fetch(`${SUPABASE_URL}/rest/v1/prompt_templates`, {
    method: "POST",
    headers: { ...HEADERS, Prefer: "return=representation" },
    body: JSON.stringify(templateData),
  });
}

const body = await res.text();
if (!res.ok) {
  console.error(`❌  Falha: ${res.status}`);
  console.error(body);
  process.exit(1);
}
const result = JSON.parse(body);
console.log("✅  Template Casa de Festas salvo!");
console.log(`   ID: ${Array.isArray(result) ? result[0].id : result.id}`);
console.log(`   Nome: ${templateData.nome}`);
console.log(`   Variáveis: ${variables.length}`);
console.log(`   Tamanho do prompt: ${system_prompt.length} caracteres`);
