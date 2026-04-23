Backend Fastify para receber webhooks da Evolution API e transformar mensagens de WhatsApp em texto interpretado.
Na Fase 2, tambem identifica pedidos de compra, estrutura itens com OpenAI e envia clarificacoes ou confirmacoes pelo WhatsApp.

## Setup

1. Instale Node.js 20 ou superior.
2. Instale dependencias:

```bash
npm install
```

3. Preencha `.env`:

```bash
OPENAI_API_KEY=sk-...
EVOLUTION_API_URL=https://sua-evolution-api
EVOLUTION_API_KEY=sua-chave
EVOLUTION_INSTANCE=sua-instancia
OPENAI_FILTER_MODEL=gpt-4o-mini
OPENAI_ORDER_MODEL=gpt-4o
ORDER_CONFIDENCE_THRESHOLD=0.8
ORDER_STATE_TTL_MINUTES=30
```

4. Inicie:

```bash
npm run dev
```

## Endpoints

### GET /health

Health check simples.

### POST /webhook/messages

Recebe payload de `MESSAGES_UPSERT` da Evolution API. O backend:

- detecta `text`, `audio` ou `image`;
- extrai texto direto, transcreve audio com `whisper-1`, ou interpreta imagem com `gpt-4o`;
- ignora mensagens `fromMe` para evitar loop com as mensagens enviadas pelo proprio bot;
- usa `gpt-4o-mini` como pre-filtro barato para decidir se e pedido;
- usa `gpt-4o` para estruturar pedidos em JSON;
- envia clarificacao quando a confianca fica abaixo do threshold;
- envia confirmacao quando o pedido esta suficientemente claro.

Resposta:

```json
{
  "type": "text",
  "customer_phone": "5521999999999",
  "text": "quero 5 kg de tomate, 3 cebola e 2 limao",
  "received_at": "2025-01-15T14:32:00Z",
  "order_status": "needs_clarification"
}
```

## Observacoes

- O estado de pedidos em andamento fica em um `Map` em memoria. Se o processo reiniciar, as clarificacoes pendentes sao perdidas.
- Nao ha banco de dados, confirmacao, cobranca, NF-e ou frontend.
- A Evolution API pode enviar midia como base64, URL ou exigir download por `/chat/getBase64FromMediaMessage/{instance}`; o roteador tenta os tres caminhos.
