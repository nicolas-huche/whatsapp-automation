Backend Fastify para receber webhooks da Evolution API e transformar mensagens de WhatsApp em texto interpretado.

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
- retorna o texto interpretado em um JSON simples.

Resposta:

```json
{
  "type": "text",
  "customer_phone": "5521999999999",
  "text": "quero 5 kg de tomate, 3 cebola e 2 limao",
  "received_at": "2025-01-15T14:32:00Z"
}
```

## Observacoes

- Nenhuma mensagem e enviada de volta ao cliente.
- O sistema apenas interpreta a mensagem recebida e retorna texto.
- Nao ha banco de dados, confirmacao, cobranca, NF-e ou frontend.
- A Evolution API pode enviar midia como base64, URL ou exigir download por `/chat/getBase64FromMediaMessage/{instance}`; o roteador tenta os tres caminhos.
