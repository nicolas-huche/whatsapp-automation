import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { routeMediaToText, extractCustomerPhone } from './services/media-router.js';
import { isPurchaseOrder } from './services/order-filter.js';
import { reasonAboutOrder } from './services/order-reasoning.js';
import { getOrderState, saveOrderState, clearOrderState, purgeExpiredOrderStates } from './services/order-state.js';
import { orderNeedsClarification, sendOrderClarification, buildClarificationQuestion } from './services/clarification.js';
import { sendTextMessage } from './services/whatsapp-sender.js';
import { AppError, toPublicError } from './errors.js';

const app = Fastify({
  logger: false,
  bodyLimit: Number(process.env.BODY_LIMIT_BYTES || 25 * 1024 * 1024)
});

await app.register(cors, {
  origin: true
});

app.setErrorHandler((error, request, reply) => {
  const publicError = toPublicError(error);
  console.error('[erro]', {
    route: request.url,
    message: error.message,
    details: error.details
  });

  reply.status(publicError.statusCode).send(publicError);
});

app.get('/health', async () => ({
  status: 'ok',
  service: 'whatsapp-message-interpreter',
  timestamp: new Date().toISOString(),
  uptime_seconds: Math.round(process.uptime())
}));

function dataFrom(payload) {
  return payload?.data ?? payload ?? {};
}

function extractInstance(payload) {
  const data = dataFrom(payload);
  return payload?.instance || data.instance || process.env.EVOLUTION_INSTANCE;
}

function isFromMe(payload) {
  const data = dataFrom(payload);
  return Boolean(data.key?.fromMe || payload?.key?.fromMe);
}

function formatQuantity(value) {
  if (value === null || value === undefined) return '';
  return Number.isInteger(value) ? String(value) : String(value).replace('.', ',');
}

function formatOrderItems(order) {
  return order.items
    .map((item) => {
      const quantity = formatQuantity(item.quantity);
      const unit = item.unit || '';
      const productName = item.product_name || item.product;
      return `- ${[quantity, unit, productName].filter(Boolean).join(' ')}`;
    })
    .join('\n');
}

function buildConfirmationMessage(order) {
  return [
    'Pedido confirmado:',
    formatOrderItems(order)
  ].join('\n');
}

async function handleWebhookMessages(request, reply) {
  const payload = request.body;

  if (isFromMe(payload)) {
    return reply.send({ ignored: true, reason: 'fromMe' });
  }

  const customerPhone = extractCustomerPhone(payload);

  if (!customerPhone) {
    throw new AppError('Nao foi possivel identificar o telefone do cliente no webhook.', 422);
  }

  // Filtra só números permitidos (se configurado)
  const allowed = process.env.ALLOWED_PHONES;
  if (allowed) {
    const allowedList = allowed.split(',').map(n => n.trim());
    if (!allowedList.includes(customerPhone)) {
      return reply.send({ ignored: true, reason: 'not_allowed', phone: customerPhone });
    }
  }

  const receivedAt = new Date().toISOString();

  console.log('[webhook] mensagem recebida', {
    receivedAt,
    event: payload?.event,
    instance: payload?.instance,
    messageId: payload?.data?.key?.id,
    customerPhone
  });

  const mediaResult = await routeMediaToText(payload);
  const interpretedMessage = {
    type: mediaResult.type,
    customer_phone: mediaResult.customerPhone,
    text: mediaResult.text,
    received_at: receivedAt
  };

  console.log('[media] texto interpretado', interpretedMessage);

  purgeExpiredOrderStates();

  const instance = extractInstance(payload);
  const existingOrderState = getOrderState(customerPhone);
  const isClarificationReply = Boolean(existingOrderState);

  if (!isClarificationReply) {
    const isOrder = await isPurchaseOrder(mediaResult.text);

    if (!isOrder) {
      console.log('[order] mensagem ignorada pelo pre-filtro', {
        customerPhone,
        messageId: payload?.data?.key?.id
      });

      return reply.send({
        ...interpretedMessage,
        order_status: 'ignored',
        reason: 'not_purchase_order'
      });
    }
  }

  const order = await reasonAboutOrder(mediaResult.text, isClarificationReply
    ? {
        order: existingOrderState.order,
        pendingQuestions: existingOrderState.pendingQuestions,
        clarificationAnswer: mediaResult.text
      }
    : null);

  if (orderNeedsClarification(order)) {
    const question = buildClarificationQuestion(order);

    saveOrderState(customerPhone, {
      order,
      pendingQuestions: [question],
      originalText: existingOrderState?.originalText || mediaResult.text
    });

    const clarification = await sendOrderClarification({
      customerPhone,
      order,
      instance
    });

    console.log('[order] clarificacao enviada', {
      customerPhone,
      items: order.items.length,
      question: clarification.question
    });

    return reply.send({
      ...interpretedMessage,
      order_status: 'needs_clarification',
      clarification: {
        sent: true,
        question: clarification.question
      },
      order
    });
  }

  clearOrderState(customerPhone);

  const confirmationText = buildConfirmationMessage(order);
  await sendTextMessage({
    to: customerPhone,
    text: confirmationText,
    instance
  });

  console.log('[order] pedido confirmado', {
    customerPhone,
    items: order.items.length,
    fromClarification: isClarificationReply
  });

  return reply.send({
    ...interpretedMessage,
    order_status: isClarificationReply ? 'clarified_and_confirmed' : 'confirmed',
    confirmation: {
      sent: true,
      text: confirmationText
    },
    order
  });
}

app.post('/webhook/messages', handleWebhookMessages);
app.post('/webhook/messages-upsert', handleWebhookMessages);

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

try {
  await app.listen({ port, host });
  console.log(`[server] ouvindo em http://${host}:${port}`);
} catch (error) {
  console.error('[server] falha ao iniciar', error);
  process.exit(1);
}
