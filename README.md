Backend Fastify para receber webhooks da Evolution API, transformar mensagens de WhatsApp em texto e gerar pedidos estruturados com OpenAI.

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
- envia o texto para o parser de pedidos;
- retorna o JSON estruturado do pedido.

### POST /test/parse

Atalho para testar somente a camada 2.

```bash
curl -X POST http://localhost:3000/test/parse \
  -H "Content-Type: application/json" \
  -d "{\"customer_phone\":\"5521999999999\",\"text\":\"manda 5 tomate, 3 cebola e 2 limao\"}"
```

## Observacoes

- O catalogo fica em `src/config/catalog.js`.
- Nenhuma mensagem e enviada de volta ao cliente.
- Nao ha banco de dados, confirmacao de pedido, cobranca, NF-e ou frontend.
- A Evolution API pode enviar midia como base64, URL ou exigir download por `/chat/getBase64FromMediaMessage/{instance}`; o roteador tenta os tres caminhos.
