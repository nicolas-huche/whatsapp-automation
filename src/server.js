import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { routeMediaToText, extractCustomerPhone, extractCustomerName } from './services/media-router.js';
import { resolveContact } from './services/contact-resolver.js';
import { isPurchaseOrder } from './services/order-filter.js';
import { reasonAboutOrder } from './services/order-reasoning.js';
import { getOrderState, saveOrderState, clearOrderState, purgeExpiredOrderStates, ORDER_STATE_STATUS } from './services/order-state.js';
import {
  orderNeedsClarification,
  sendOrderClarification,
  buildClarificationQuestion,
  isConfirmationReply,
  isCancellationReply,
  sendOrderConfirmationRequest,
  buildOrderConfirmedMessage
} from './services/clarification.js';
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

async function askForOrderConfirmation({
  reply,
  interpretedMessage,
  customerPhone,
  customerName,
  resolvedPhone,
  instance,
  order,
  existingOrderState,
  heading = 'Seu pedido:'
}) {
  saveOrderState(customerPhone, {
    status: ORDER_STATE_STATUS.AWAITING_CONFIRMATION,
    order,
    pendingQuestions: [],
    originalText: existingOrderState?.originalText || interpretedMessage.text
  });

  const confirmationRequest = await sendOrderConfirmationRequest({
    customerPhone,
    order,
    instance,
    heading
  });

  console.log('[order] aguardando confirmacao', {
    customerPhone,
    customerName,
    resolvedPhone,
    items: order.items.length,
    message: confirmationRequest.message
  });

  return reply.send({
    ...interpretedMessage,
    order_status: ORDER_STATE_STATUS.AWAITING_CONFIRMATION,
    confirmation_request: {
      sent: true,
      text: confirmationRequest.message
    },
    order
  });
}

async function handleReasonedOrder({
  reply,
  interpretedMessage,
  customerPhone,
  customerName,
  resolvedPhone,
  instance,
  order,
  existingOrderState,
  confirmationHeading = 'Seu pedido:'
}) {
  if (orderNeedsClarification(order)) {
    const question = buildClarificationQuestion(order);

    saveOrderState(customerPhone, {
      status: ORDER_STATE_STATUS.AWAITING_CLARIFICATION,
      order,
      pendingQuestions: [question],
      originalText: existingOrderState?.originalText || interpretedMessage.text
    });

    const clarification = await sendOrderClarification({
      customerPhone,
      order,
      instance
    });

    console.log('[order] clarificacao enviada', {
      customerPhone,
      customerName,
      resolvedPhone,
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

  return askForOrderConfirmation({
    reply,
    interpretedMessage,
    customerPhone,
    customerName,
    resolvedPhone,
    instance,
    order,
    existingOrderState,
    heading: confirmationHeading
  });
}

async function handleWebhookMessages(request, reply) {
  const payload = request.body;

  if (isFromMe(payload)) {
    return reply.send({ ignored: true, reason: 'fromMe' });
  }

  const customerPhone = extractCustomerPhone(payload);
  const customerName = extractCustomerName(payload);

  if (!customerPhone) {
    throw new AppError('Nao foi possivel identificar o telefone do cliente no webhook.', 422);
  }

  const instance = extractInstance(payload);
  const resolved = await resolveContact(customerPhone, instance);
  const resolvedPhone = resolved.phone;
  const phoneForFilter = resolvedPhone || customerPhone;

  console.log('[contact] identificador resolvido', {
    raw: customerPhone,
    resolved: resolvedPhone,
    isLid: resolved.isLid,
    customerName
  });

  const shouldApplyAllowedPhones = !resolved.isLid || Boolean(resolvedPhone);

  // Filtra só números permitidos (se configurado)
  const allowed = process.env.ALLOWED_PHONES?.trim();
  if (allowed && shouldApplyAllowedPhones) {
    const allowedList = allowed.split(',').map(n => n.trim()).filter(Boolean);
    if (allowedList.length && !allowedList.includes(phoneForFilter)) {
      return reply.send({ ignored: true, reason: 'not_allowed', phone: phoneForFilter });
    }
  }

  const receivedAt = new Date().toISOString();

  console.log('[webhook] mensagem recebida', {
    receivedAt,
    event: payload?.event,
    instance: payload?.instance,
    messageId: payload?.data?.key?.id,
    customerPhone,
    customerName,
    resolvedPhone
  });

  const mediaResult = await routeMediaToText(payload);
  const interpretedMessage = {
    type: mediaResult.type,
    customer_phone: mediaResult.customerPhone,
    text: mediaResult.text,
    received_at: receivedAt
  };

  console.log('[media] texto interpretado', {
    ...interpretedMessage,
    customerName,
    resolvedPhone
  });

  purgeExpiredOrderStates();

  const existingOrderState = getOrderState(customerPhone);
  const stateStatus = existingOrderState?.status || (
    existingOrderState ? ORDER_STATE_STATUS.AWAITING_CLARIFICATION : null
  );

  if (stateStatus === ORDER_STATE_STATUS.AWAITING_CONFIRMATION) {
    if (isCancellationReply(mediaResult.text)) {
      clearOrderState(customerPhone);

      const cancellationText = 'Pedido cancelado.';
      await sendTextMessage({
        to: customerPhone,
        text: cancellationText,
        instance
      });

      console.log('[order] pedido cancelado', {
        customerPhone,
        customerName,
        resolvedPhone,
        items: existingOrderState.order?.items?.length || 0
      });

      return reply.send({
        ...interpretedMessage,
        order_status: 'cancelled',
        cancellation: {
          sent: true,
          text: cancellationText
        },
        order: existingOrderState.order
      });
    }

    if (isConfirmationReply(mediaResult.text)) {
      clearOrderState(customerPhone);

      const confirmationText = buildOrderConfirmedMessage(existingOrderState.order);
      await sendTextMessage({
        to: customerPhone,
        text: confirmationText,
        instance
      });

      console.log('[order] pedido confirmado', {
        customerPhone,
        customerName,
        resolvedPhone,
        items: existingOrderState.order.items.length,
        confirmedByCustomer: true
      });

      console.log('[order] pedido confirmado pelo cliente', {
        customerPhone,
        customerName,
        resolvedPhone,
        items: existingOrderState.order.items.length
      });

      return reply.send({
        ...interpretedMessage,
        order_status: 'confirmed',
        confirmation: {
          sent: true,
          text: confirmationText
        },
        order: existingOrderState.order
      });
    }

    console.log('[order] correcao recebida', {
      customerPhone,
      customerName,
      resolvedPhone,
      text: mediaResult.text
    });

    const correctedOrder = await reasonAboutOrder(mediaResult.text, {
      order: existingOrderState.order,
      pendingQuestions: existingOrderState.pendingQuestions,
      correctionText: mediaResult.text
    });

    return handleReasonedOrder({
      reply,
      interpretedMessage,
      customerPhone,
      customerName,
      resolvedPhone,
      instance,
      order: correctedOrder,
      existingOrderState,
      confirmationHeading: 'Pedido atualizado:'
    });
  }

  if (stateStatus === ORDER_STATE_STATUS.AWAITING_CLARIFICATION) {
    const clarifiedOrder = await reasonAboutOrder(mediaResult.text, {
      order: existingOrderState.order,
      pendingQuestions: existingOrderState.pendingQuestions,
      clarificationAnswer: mediaResult.text
    });

    return handleReasonedOrder({
      reply,
      interpretedMessage,
      customerPhone,
      customerName,
      resolvedPhone,
      instance,
      order: clarifiedOrder,
      existingOrderState
    });
  }

  const isOrder = await isPurchaseOrder(mediaResult.text);

  if (!isOrder) {
    console.log('[order] mensagem ignorada pelo pre-filtro', {
      customerPhone,
      customerName,
      resolvedPhone,
      messageId: payload?.data?.key?.id
    });

    return reply.send({
      ...interpretedMessage,
      order_status: 'ignored',
      reason: 'not_purchase_order'
    });
  }

  const order = await reasonAboutOrder(mediaResult.text);

  return handleReasonedOrder({
    reply,
    interpretedMessage,
    customerPhone,
    customerName,
    resolvedPhone,
    instance,
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
