# PedidoBot — Automação de Pedidos via WhatsApp

## O que é

Backend Node.js (Fastify) que recebe mensagens de clientes no WhatsApp, interpreta com IA, estrutura o pedido, gera cobrança e emite nota fiscal automaticamente. O negócio não tem catálogo fixo — vende qualquer produto que o cliente pedir. A IA identifica os produtos livremente, sem match com banco de dados.

## Stack

- **Runtime:** Node.js + Fastify
- **WhatsApp:** Evolution API (self-hosted, open-source)
- **Áudio → Texto:** OpenAI Whisper API
- **Imagem → Texto:** GPT-4o Vision
- **Pré-filtro (texto é pedido?):** GPT-4o-mini
- **Raciocínio (texto → pedido estruturado):** GPT-4o
- **Planilha:** Google Sheets + Google Apps Script
- **Cobrança:** Asaas ou Mercado Pago (Pix/boleto)
- **NF-e:** Focus NFe ou eNotas
- **Fila (opcional):** BullMQ + Redis

## Fluxo Completo

```
Cliente manda mensagem no WhatsApp (texto, áudio ou foto)
        │
        ▼
Evolution API (webhook POST /webhook/messages)
        │
        ▼
Backend Fastify recebe o payload
        │
        ▼
IA INTERPRETADORA (Camada 1 — conversão burra)
   ├── Se TEXT → passa direto
   ├── Se AUDIO → Whisper API transcreve → texto
   └── Se IMAGE → GPT-4o Vision interpreta → texto
        │
        ▼
PRÉ-FILTRO (Camada 1.5 — triagem barata)
   GPT-4o-mini recebe o texto e classifica:
   É um pedido de compra? → SIM ou NÃO
        │
        ├── Se NÃO → responde "não entendi como pedido"
        │            via WhatsApp (ou ignora) — FIM
        │
        └── Se SIM ↓
        │
        ▼
IA DE RACIOCÍNIO (Camada 2 — inteligência)
   GPT-4o recebe o texto e extrai:
   - Nome de cada produto (livre, sem catálogo)
   - Quantidade
   - Unidade inferida (kg, unidade, dúzia, maço, etc.)
   Retorna JSON estruturado SEM preços.
        │
        ▼
VERIFICA CONFIDENCE DE CADA ITEM
        │
        ├── Se ALGUM item tem confidence < 0.8 (threshold configurável):
        │      │
        │      ▼
        │   Backend monta pergunta de clarificação
        │   usando o campo "ambiguities" do JSON
        │      │
        │      ▼
        │   Evolution API envia pergunta pro cliente
        │   Ex: "Você quis dizer 2kg ou 2 unidades de limão?"
        │      │
        │      ▼
        │   Cliente responde no WhatsApp
        │      │
        │      ▼
        │   Resposta entra de novo pelo webhook
        │   → IA Interpretadora (se for áudio/imagem)
        │   → IA de Raciocínio (agora com contexto do pedido anterior + resposta)
        │   → Verifica confidence de novo
        │   (LOOP até todos os itens terem confidence >= 0.8)
        │
        └── Se TODOS os itens têm confidence >= 0.8:
               │
               ▼
          ┌────┴────┐
          │         │
          ▼         ▼
       CONFIRMA    GERA PLANILHA
       no WhatsApp  no Google Sheets
       (Evolution   (sem preços,
        API envia    só produtos
        mensagem)    e quantidades)
                     │
                     ▼
             VOCÊ PREENCHE OS PREÇOS
             manualmente no Google Sheets
             e marca a coluna "Status" como PRONTO
                     │
                     ▼
             Google Apps Script detecta o PRONTO
             e faz POST para o backend:
             POST /order/finalize
             com os dados da planilha + preços
                     │
                     ▼
             Backend gera Pix/boleto
             via gateway de pagamento (Asaas ou Mercado Pago)
                     │
                     ▼
             Evolution API manda link de pagamento
             pro cliente via WhatsApp
                     │
                     ▼
             CLIENTE PAGA
                     │
                     ▼
             Webhook do gateway confirma pagamento
             POST /webhook/payment no backend
                     │
                     ▼
             Backend emite NF-e
             via Focus NFe ou eNotas
                     │
                     ▼
             Imprime (NF-e + ordem de separação)
```

## JSON de saída da IA de Raciocínio (sem preços)

```json
{
  "customer_phone": "5521999999999",
  "items": [
    {
      "product_name": "Tomate",
      "quantity": 5,
      "unit": "kg",
      "unit_was_inferred": true,
      "confidence": 0.95,
      "inference_reason": "Tomate é vendido a granel, assume kg"
    },
    {
      "product_name": "Alface",
      "quantity": 2,
      "unit": "unidade",
      "unit_was_inferred": true,
      "confidence": 0.98,
      "inference_reason": "Alface é vendida por cabeça, assume unidade"
    },
    {
      "product_name": "Limão",
      "quantity": 2,
      "unit": "kg",
      "unit_was_inferred": true,
      "confidence": 0.55,
      "inference_reason": "Ambíguo: pode ser 2kg ou 2 unidades"
    }
  ],
  "ambiguities": [
    {
      "product_name": "Limão",
      "question": "Você quis dizer 2kg ou 2 unidades de limão?",
      "options": ["2 kg", "2 unidades"]
    }
  ],
  "original_text": "manda 5 tomate, 2 alface e 2 limão"
}
```

## Endpoints do Backend

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | /health | Health check |
| POST | /webhook/messages | Recebe webhook da Evolution API |
| POST | /order/finalize | Recebe dados do Google Sheets com preços preenchidos |
| POST | /webhook/payment | Recebe confirmação de pagamento do gateway |

## Estrutura do Projeto

```
src/
  server.js                — Fastify server + rotas
  services/
    media-router.js        — detecta tipo da mensagem e roteia
    audio.js               — chama Whisper API (áudio → texto)
    image.js               — chama GPT-4o Vision (imagem → texto)
    order-filter.js        — chama GPT-4o-mini (texto é pedido? sim/não)
    order-reasoning.js     — chama GPT-4o (texto → JSON do pedido)
    order-state.js         — gerencia estado de pedidos em andamento (Map em memória ou Redis)
    clarification.js       — monta perguntas de clarificação e envia via WhatsApp
    sheets.js              — cria linha no Google Sheets
    billing.js             — gera Pix/boleto via Asaas ou Mercado Pago
    invoice.js             — emite NF-e via Focus NFe ou eNotas
    whatsapp-sender.js     — envia mensagens via Evolution API
  errors.js                — classe AppError + tratamento de erros
```

## Variáveis de Ambiente

```
PORT=3000
HOST=0.0.0.0

OPENAI_API_KEY=sk-...

OPENAI_FILTER_MODEL=gpt-4o-mini
CONFIDENCE_THRESHOLD=0.8

EVOLUTION_API_URL=https://sua-evolution-api
EVOLUTION_API_KEY=sua-chave
EVOLUTION_INSTANCE=nome-da-instancia

GOOGLE_SHEETS_ID=id-da-planilha
GOOGLE_SERVICE_ACCOUNT_KEY=path-para-credentials.json

ASAAS_API_KEY=sua-chave-asaas (ou MERCADOPAGO_ACCESS_TOKEN)

FOCUSNFE_API_KEY=sua-chave (ou ENOTAS_API_KEY)
```

## Regras Importantes

- **Não existe catálogo de produtos.** A empresa vende qualquer coisa que o cliente pedir. A IA identifica os produtos livremente pelo nome.
- **Preços não são definidos pela IA.** A IA nunca calcula preço. Os preços são preenchidos manualmente na planilha do Google Sheets.
- **O backend Fastify é o centro de tudo.** Ele recebe webhooks do WhatsApp, callbacks do Google Sheets, e webhooks do gateway de pagamento.
- **Unidades são inferidas pela IA** com base no contexto (tomate → kg, alface → unidade, ovos → dúzia). Quando ambíguo, deve sinalizar com confidence baixo e gerar uma pergunta para o cliente.
- **Loop de clarificação:** se qualquer item do pedido tiver confidence abaixo do threshold (0.8), o backend envia pergunta de clarificação pro cliente via WhatsApp. A resposta do cliente volta pelo pipeline completo (interpretador → raciocínio) com o contexto do pedido anterior. O loop repete até todos os itens terem confidence >= 0.8. Só então o pedido avança para confirmação e planilha.
- **O backend precisa manter estado do pedido em andamento** — saber que a próxima mensagem daquele cliente é uma resposta de clarificação, não um pedido novo. Isso pode ser feito com um Map em memória (simples) ou Redis (robusto).
- **Pré-filtro com GPT-4o-mini:** antes de chamar o GPT-4o (caro), o texto interpretado passa por um pré-filtro com GPT-4o-mini (~20x mais barato) que classifica se a mensagem é um pedido de compra ou não. Se não for pedido, o backend responde ao cliente ou ignora, sem gastar com o GPT-4o. Mensagens que são respostas de clarificação (cliente respondendo a uma pergunta do bot) pulam o pré-filtro e vão direto para a IA de Raciocínio.

## Fases de Desenvolvimento

### Fase 1 — IA Interpretadora
Mensagem do WhatsApp → media-router → texto interpretado (áudio/imagem viram texto).

### Fase 2 — Pré-filtro + IA de Raciocínio + Loop de Clarificação
Texto interpretado → GPT-4o-mini classifica se é pedido ou não (triagem barata para evitar custo desnecessário com GPT-4o). Se for pedido → GPT-4o estrutura o pedido em JSON (produtos, quantidades, unidades, sem preços). Se algum item tiver confidence baixo, envia pergunta pro cliente via WhatsApp e aguarda resposta. A resposta volta pelo pipeline (interpretador → pré-filtro → raciocínio). Só avança quando tudo tiver confidence alto.

### Fase 3 — Confirmação + Google Sheets
Envia confirmação pro cliente via WhatsApp + cria planilha no Google Sheets sem preços.

### Fase 4 — Finalização (preços + cobrança)
Você preenche preços na planilha → Apps Script chama /order/finalize → gera Pix/boleto → manda pro cliente.

### Fase 5 — Pagamento + NF-e
Webhook do gateway confirma pagamento → emite NF-e → imprime.
