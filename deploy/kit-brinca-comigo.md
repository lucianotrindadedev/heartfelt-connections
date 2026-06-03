# Kit de implantação — Casa de Festas Brinca Comigo

Use o template **"Casa de Festas — Google Calendar"** (categoria *eventos*) e preencha
com os valores abaixo. O fluxo é: o agente "Vivi" dá todos os detalhes do espaço,
**agenda a VISITA** (agenda *Visitas*) e **transfere o fechamento da festa** (data,
valor, pagamento) para um humano.

---

## 1. Variáveis do template (passo "Variáveis" do assistente)

| Campo | Valor |
|---|---|
| Nome da atendente virtual | `Vivi` |
| Como a atendente se descreve | `atendente da Casa de Festas Brinca Comigo` |
| Nome da casa de festas | `Casa de Festas Brinca Comigo` |
| Endereço completo | `Rua das Camélias, 514 - Vila Valqueire, Rio de Janeiro - RJ` |
| Ponto de referência (opcional) | *(deixar em branco)* |
| Horário de funcionamento | `Todos os dias, das 11h às 20h` |
| Capacidade de convidados (mín–máx) | `de 60 a 200 convidados` |
| Rótulo do agendamento | `Visita ao espaço` |
| Duração da visita ao espaço (minutos) | `60` |
| Formas de pagamento | `Pix, dinheiro, débito e crédito` |
| Diferenciais (1 por linha) | `19 anos de mercado`<br>`Espaço amplo e bem localizado`<br>`Área planejada para os adultos, separada da área das crianças`<br>`Buffet infantil completo`<br>`Entretenimento para todas as idades`<br>`Decoração feita conforme o gosto do cliente` |
| Temas mais procurados | `Jardim, Fundo do Mar, Circo, Pequena Sereia` |
| Pergunta de compromisso (opcional) | `Posso confirmar sua visita então?` |
| (Avançado) Campos a coletar — JSON | ver bloco abaixo |

### Campos a coletar antes da visita (JSON) — cole no campo avançado
> Importante: sem este JSON, o motor entende "visita" como visita escolar e pede
> "nome da criança / responsáveis". Este JSON coleta só o nome do responsável.

```json
[
  {"key":"name","label":"Nome completo","question":"Pra confirmar sua visita, como é o seu nome completo?","required":true,"maps_to":"name"}
]
```

---

## 2. Google Calendar — agendas

No painel do agente → card **Google Calendar** → conecte a conta Google e, em
**"Múltiplas agendas (avançado)"**, cadastre:

| Calendário (Google) | Nome / label | Quando usar (descrição) |
|---|---|---|
| Calendário de visitas | `Visitas` | Agendar visitas ao espaço para a família conhecer. **Use esta agenda para marcar visitas.** |
| Calendário de festas | `Festas` | Festas já confirmadas no espaço. **NÃO agende festas aqui — disponibilidade e fechamento são com um humano.** |

> Se você só tiver uma agenda no momento, cadastre apenas **Visitas** — o template
> funciona igual (o agente marca visitas e transfere a festa para um humano).

### Horário em que o agente pode oferecer visitas
No card do Google Calendar, configure o **horário de funcionamento estruturado**
(business hours) usado para gerar os horários livres. Sugestão: todos os dias,
**11h às 20h** (ajuste se as visitas tiverem janela própria, ex. 11h–18h).

### Template do evento (no card do Google Calendar)
- **Título do evento:** `Visita - {name}`
- **Descrição do evento:**
  ```
  Visita ao espaço
  Telefone: {phone}
  {notes}
  ```

---

## 3. Escalada humana (festa = humano)

No card de **Escalada humana**, ative a transferência e configure o grupo/instância.
O agente vai transferir para um humano quando o lead quiser: disponibilidade de data
da festa, negociação de valor, ou definir forma de pagamento/fechar a festa.

---

## 4. Base de Conhecimento (detalhes do pacote, preços e regras)

No card **Base de Conhecimento**, cole o texto abaixo (ou suba um PDF equivalente).
O agente busca aqui para responder sobre o pacote, FAQs e regras.

```
PACOTE DE FESTA — CASA DE FESTAS BRINCA COMIGO

Duração da festa: 4 horas.
Capacidade: de 60 a 200 convidados.
Horário de funcionamento: todos os dias, das 11h às 20h.

O QUE ESTÁ INCLUSO NO PACOTE:
- Bolo
- Docinho volante
- Salgados variados
- Buffet infantil
- Sorvete liberado
- Mini buffet de hot dog
- Entradas: penne ao molho branco e ao molho sugo
- Almoço ou jantar: strogonoff de frango com arroz e batata palha;
  ou panqueca de carne ou frango com arroz e salada
- Bebidas: refrigerante, suco, guaraná natural e água
- Decoração
- Animação
- DJ
- Convite

TEMAS MAIS PROCURADOS: Jardim, Fundo do Mar, Circo, Pequena Sereia
(a decoração é feita conforme o gosto do cliente).

FORMAS DE PAGAMENTO:
Sinal de 20% para reservar a data; o restante pode ser parcelado até 10 dias
antes da festa. Aceitamos Pix, dinheiro, débito e crédito.

DIFERENCIAIS:
19 anos de mercado, espaço amplo e bem localizado, área planejada para que os
adultos não fiquem dentro da área das crianças, buffet completo e entretenimento
para todas as idades.

PERGUNTAS FREQUENTES:
- Onde fica o espaço? Rua das Camélias, 514 - Vila Valqueire.
- O que está incluso no pacote? (ver lista acima)
- Quais as formas de pagamento? Sinal de 20% para reservar; restante parcelado
  até 10 dias antes da festa. Pix, dinheiro, débito e crédito.
- Qual a capacidade? De 60 a 200 convidados.
- Quanto custa / orçamento? Os valores variam conforme a quantidade de convidados
  e a data. O melhor é agendar uma visita: na visita a equipe apresenta todas as
  condições. Posso já reservar um horário pra você conhecer o espaço?
```

> Observação: os **valores em R$** não vieram no formulário. Enquanto não forem
> definidos, o agente conduz para a visita (onde a equipe passa os valores). Quando
> tiver a tabela de preços por número de convidados, é só acrescentar nesse texto.

---

## 5. Itens que ficaram pendentes no formulário (confirmar com o cliente)

- **Tabela de preços** (orçamento por nº de convidados) — para o agente informar valores.
- **Política de cancelamento e de remarcação** — não informadas.
- **Janela específica de visitas** (se for diferente do funcionamento 11h–20h).
- **Palavras proibidas/recomendadas** do tom de voz — vieram em branco.
