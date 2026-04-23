Backend Fastify que recebe webhooks da Evolution API, interpreta mensagens de WhatsApp (texto/audio/imagem),
estrutura pedidos com OpenAI, grava na planilha do Google Sheets, cria cobranca Pix e emite NF-e
quando o pagamento e confirmado.

## Setup

1. Instale Node.js 20 ou superior.
2. Instale dependencias:

```bash
npm install
```

3. Preencha `.env` (veja `.env.example`). Em producao, preencha apenas o provider que voce usa
   (Asaas OU Mercado Pago, Focus NFe OU eNotas).

4. Crie a planilha do Google e compartilhe com o email do service account.
   Cabecalho na primeira linha da aba `Pedidos`:

```
timestamp | order_id | customer_phone | customer_name | product | quantity | unit | unit_price | total | status
```

   Instale o Google Apps Script em `apps-script/Code.gs` (ver instrucoes no topo do
   arquivo). Ele detecta `status = PRONTO` e chama `POST /order/finalize`
   automaticamente. A funcao `setupSheet` cria cabecalho e validacao de dados da
   coluna status de uma vez.

5. Inicie:

```bash
npm run dev
```

## Endpoints

### GET /health

Health check.

### POST /webhook/messages

Recebe `MESSAGES_UPSERT` da Evolution API. O backend:

- detecta `text`, `audio` ou `image`;
- transcreve audio com Whisper e interpreta imagem com GPT-4o Vision;
- ignora `fromMe` para evitar loops;
- filtra por `ALLOWED_PHONES` se configurado;
- usa GPT-4o-mini como pre-filtro (pedido ou nao);
- usa GPT-4o para estruturar o pedido em JSON;
- envia pergunta de clarificacao se algum item tiver confidence baixo;
- pede confirmacao quando o pedido esta completo;
- ao confirmar, adiciona uma linha por item na planilha do Google Sheets.

### POST /order/finalize

Chamado pelo Google Apps Script quando voce marca a linha como PRONTO na planilha. Payload:

```json
{
  "order_id": "P-20260101-ABCD",
  "customer_phone": "5521999999999",
  "customer_name": "Joao",
  "customer_document": "12345678909",
  "customer_email": "opcional@exemplo.com",
  "items": [
    { "product_name": "tomate", "quantity": 5, "unit": "kg", "unit_price": 8.50 }
  ],
  "total": 42.50
}
```

Cria cobranca Pix no provider configurado (Asaas ou Mercado Pago), envia o link de pagamento
pelo WhatsApp e guarda o pedido aguardando pagamento.

### POST /webhook/payment

Webhook do gateway de pagamento. Para Asaas, o payload ja traz `event` e `payment`. Para
Mercado Pago, o backend consulta `/v1/payments/{id}` para confirmar status e recuperar
`external_reference`. Quando o pagamento e aprovado:

- emite NF-e (Focus NFe ou eNotas);
- envia mensagem de confirmacao com a URL da NF-e para o cliente;
- limpa o pedido do store de pagamentos pendentes.

## Fases implementadas

- Fase 1 — Interpretacao de midia (texto/audio/imagem) → `src/services/media-router.js`, `audio.js`, `image.js`.
- Fase 2 — Pre-filtro, raciocinio e loop de clarificacao → `order-filter.js`, `order-reasoning.js`, `order-state.js`, `clarification.js`.
- Fase 3 — Confirmacao + Google Sheets → `sheets.js` e handler de confirmacao em `server.js`.
- Fase 4 — Cobranca Pix (Asaas ou Mercado Pago) → `billing.js` e `POST /order/finalize`.
- Fase 5 — Emissao de NF-e (Focus NFe ou eNotas) → `invoice.js` e `POST /webhook/payment`.

## Observacoes

- O estado de pedidos em andamento fica em `Map` em memoria (`order-state.js`, `order-store.js`).
  Se o processo reiniciar, pedidos aguardando clarificacao ou pagamento sao perdidos.
- A autenticacao do Google Sheets usa JWT RS256 assinado nativamente com `crypto`, sem
  dependencia do SDK `googleapis`.
- A Evolution API pode enviar midia como base64, URL ou exigir download por
  `/chat/getBase64FromMediaMessage/{instance}`; o roteador tenta os tres caminhos.
