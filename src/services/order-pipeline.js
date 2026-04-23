import { AppError } from '../errors.js';
import { routeMediaToText, extractCustomerPhone, extractCustomerName } from './media-router.js';
import { resolveContact } from './contact-resolver.js';
import { isPurchaseOrder } from './order-filter.js';
import { reasonAboutOrder } from './order-reasoning.js';
import {
  getOrderState,
  saveOrderState,
  clearOrderState,
  purgeExpiredOrderStates,
  ORDER_STATE_STATUS
} from './order-state.js';
import {
  orderNeedsClarification,
  sendOrderClarification,
  buildClarificationQuestion,
  isConfirmationReply,
  isCancellationReply,
  sendOrderConfirmationRequest,
  buildOrderConfirmedMessage
} from './clarification.js';
import { sendTextMessage } from './whatsapp-sender.js';
import { appendOrderToSheet, generateOrderId } from './sheets.js';
import { createPixCharge, parsePaymentWebhook, fetchMercadoPagoPayment } from './billing.js';
import { issueInvoice } from './invoice.js';
import {
  savePendingPayment,
  getPendingPayment,
  clearPendingPayment,
  purgeExpiredPendingPayments
} from './order-store.js';

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

function formatMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `R$ ${n.toFixed(2).replace('.', ',')}` : String(value);
}

function isPhoneAllowed(phone) {
  const allowed = process.env.ALLOWED_PHONES?.trim();
  if (!allowed) return true;

  const list = allowed.split(',').map((n) => n.trim()).filter(Boolean);
  if (!list.length) return true;

  return list.includes(phone);
}

async function buildClarificationResponse({
  interpretedMessage,
  customerPhone,
  customerName,
  resolvedPhone,
  instance,
  order,
  existingOrderState
}) {
  const question = buildClarificationQuestion(order);

  await saveOrderState(customerPhone, {
    status: ORDER_STATE_STATUS.AWAITING_CLARIFICATION,
    order,
    pendingQuestions: [question],
    originalText: existingOrderState?.originalText || interpretedMessage.text,
    customerName: customerName || existingOrderState?.customerName || null
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

  return {
    ...interpretedMessage,
    order_status: 'needs_clarification',
    clarification: {
      sent: true,
      question: clarification.question
    },
    order
  };
}

async function buildConfirmationRequestResponse({
  interpretedMessage,
  customerPhone,
  customerName,
  resolvedPhone,
  instance,
  order,
  existingOrderState,
  heading = 'Seu pedido:'
}) {
  await saveOrderState(customerPhone, {
    status: ORDER_STATE_STATUS.AWAITING_CONFIRMATION,
    order,
    pendingQuestions: [],
    originalText: existingOrderState?.originalText || interpretedMessage.text,
    customerName
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

  return {
    ...interpretedMessage,
    order_status: ORDER_STATE_STATUS.AWAITING_CONFIRMATION,
    confirmation_request: {
      sent: true,
      text: confirmationRequest.message
    },
    order
  };
}

async function routeReasonedOrder(params) {
  if (orderNeedsClarification(params.order)) {
    return buildClarificationResponse(params);
  }
  return buildConfirmationRequestResponse(params);
}

async function handleConfirmedOrder({
  interpretedMessage,
  customerPhone,
  customerName,
  resolvedPhone,
  instance,
  existingOrderState
}) {
  await clearOrderState(customerPhone);

  const confirmationText = buildOrderConfirmedMessage(existingOrderState.order);
  await sendTextMessage({
    to: customerPhone,
    text: confirmationText,
    instance
  });

  const savedName = existingOrderState.customerName || customerName || null;
  let sheetResult = null;

  try {
    sheetResult = await appendOrderToSheet({
      order: existingOrderState.order,
      customerPhone,
      customerName: savedName,
      orderId: generateOrderId()
    });

    console.log('[order] pedido salvo na planilha', {
      customerPhone,
      customerName: savedName,
      orderId: sheetResult.orderId,
      updatedRange: sheetResult.updatedRange
    });
  } catch (error) {
    console.error('[order] falha ao salvar na planilha', {
      customerPhone,
      error: error.message,
      details: error.details
    });
  }

  console.log('[order] pedido confirmado', {
    customerPhone,
    customerName: savedName,
    resolvedPhone,
    items: existingOrderState.order.items.length,
    orderId: sheetResult?.orderId || null
  });

  return {
    ...interpretedMessage,
    order_status: 'confirmed',
    confirmation: {
      sent: true,
      text: confirmationText
    },
    order: existingOrderState.order,
    sheet: sheetResult,
    order_id: sheetResult?.orderId || null
  };
}

async function handleCancelledOrder({
  interpretedMessage,
  customerPhone,
  customerName,
  resolvedPhone,
  instance,
  existingOrderState
}) {
  await clearOrderState(customerPhone);

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

  return {
    ...interpretedMessage,
    order_status: 'cancelled',
    cancellation: {
      sent: true,
      text: cancellationText
    },
    order: existingOrderState.order
  };
}

export async function runIncomingMessagePipeline(payload) {
  if (isFromMe(payload)) {
    return { ignored: true, reason: 'fromMe' };
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

  if (!isPhoneAllowed(phoneForFilter)) {
    console.log('[filter] mensagem bloqueada', {
      phoneForFilter,
      customerPhone,
      resolvedPhone,
      customerName,
      hint: `Para permitir, adicione ${phoneForFilter} no ALLOWED_PHONES`
    });
    return { ignored: true, reason: 'not_allowed', phone: phoneForFilter };
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

  await purgeExpiredOrderStates();

  const existingOrderState = await getOrderState(customerPhone);
  const stateStatus = existingOrderState?.status || null;

  if (stateStatus === ORDER_STATE_STATUS.AWAITING_CONFIRMATION) {
    if (isCancellationReply(mediaResult.text)) {
      return handleCancelledOrder({
        interpretedMessage,
        customerPhone,
        customerName,
        resolvedPhone,
        instance,
        existingOrderState
      });
    }

    if (isConfirmationReply(mediaResult.text)) {
      return handleConfirmedOrder({
        interpretedMessage,
        customerPhone,
        customerName,
        resolvedPhone,
        instance,
        existingOrderState
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

    return routeReasonedOrder({
      interpretedMessage,
      customerPhone,
      customerName,
      resolvedPhone,
      instance,
      order: correctedOrder,
      existingOrderState,
      heading: 'Pedido atualizado:'
    });
  }

  if (stateStatus === ORDER_STATE_STATUS.AWAITING_CLARIFICATION) {
    const clarifiedOrder = await reasonAboutOrder(mediaResult.text, {
      order: existingOrderState.order,
      pendingQuestions: existingOrderState.pendingQuestions,
      clarificationAnswer: mediaResult.text
    });

    return routeReasonedOrder({
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

    return {
      ...interpretedMessage,
      order_status: 'ignored',
      reason: 'not_purchase_order'
    };
  }

  const order = await reasonAboutOrder(mediaResult.text);

  return routeReasonedOrder({
    interpretedMessage,
    customerPhone,
    customerName,
    resolvedPhone,
    instance,
    order
  });
}

function normalizeFinalizeItems(rawItems) {
  if (!Array.isArray(rawItems) || !rawItems.length) {
    throw new AppError('Pedido sem itens para finalizar.', 422);
  }

  return rawItems.map((item, index) => {
    const quantity = Number(item.quantity ?? item.quantidade);
    const unitPrice = Number(item.unit_price ?? item.preco_unitario ?? item.price);
    const lineTotal = Number(item.total ?? item.subtotal ?? quantity * unitPrice);
    const productName = String(item.product_name || item.product || item.nome || item.produto || '').trim();

    if (!productName) {
      throw new AppError(`Item ${index + 1} sem nome de produto.`, 422);
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new AppError(`Item ${productName} com quantidade invalida.`, 422);
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new AppError(`Item ${productName} com preco unitario invalido.`, 422);
    }

    return {
      product_name: productName,
      quantity,
      unit: (item.unit || item.unidade || 'un').toLowerCase(),
      unit_price: unitPrice,
      total: Number.isFinite(lineTotal) && lineTotal > 0 ? lineTotal : Number((quantity * unitPrice).toFixed(2)),
      ncm: item.ncm || null,
      code: item.code || item.codigo || null
    };
  });
}

function buildPaymentMessage({ orderId, charge, total }) {
  const lines = [
    `Seu pedido ${orderId} esta pronto! 🙌`,
    `Total: ${formatMoney(total)}`,
    ''
  ];

  if (charge.pix_copy_paste) {
    lines.push('Pix copia e cola:');
    lines.push(charge.pix_copy_paste);
    lines.push('');
  }

  if (charge.payment_link) {
    lines.push(`Link de pagamento: ${charge.payment_link}`);
  }

  lines.push('Assim que o pagamento cair, enviamos a nota fiscal por aqui.');

  return lines.join('\n');
}

export async function runFinalizeOrderPipeline(body) {
  const orderId = String(body.order_id || body.orderId || '').trim();
  if (!orderId) {
    throw new AppError('order_id obrigatorio.', 422);
  }

  const customerPhone = String(body.customer_phone || body.phone || '').replace(/\D/g, '');
  if (!customerPhone) {
    throw new AppError('customer_phone obrigatorio.', 422);
  }

  const items = normalizeFinalizeItems(body.items);
  const totalFromItems = items.reduce((sum, item) => sum + item.total, 0);
  const total = Number.isFinite(Number(body.total)) && Number(body.total) > 0
    ? Number(body.total)
    : Number(totalFromItems.toFixed(2));

  const customer = {
    name: body.customer_name || body.customerName || null,
    document: body.customer_document || body.document || body.cpf_cnpj || null,
    email: body.customer_email || body.email || null,
    phone: customerPhone
  };

  const instance = body.instance || process.env.EVOLUTION_INSTANCE;

  const charge = await createPixCharge({
    externalReference: orderId,
    amount: total,
    description: `Pedido ${orderId}`,
    customer
  });

  await savePendingPayment(orderId, {
    customer,
    customerPhone,
    instance,
    items,
    total,
    charge: {
      id: charge.id,
      provider: charge.provider,
      payment_link: charge.payment_link,
      status: charge.status
    }
  });

  const message = buildPaymentMessage({ orderId, charge, total });

  let sendResult = null;
  try {
    sendResult = await sendTextMessage({ to: customerPhone, text: message, instance });
  } catch (error) {
    console.error('[finalize] falha ao enviar mensagem de pagamento', {
      orderId,
      customerPhone,
      error: error.message
    });
  }

  console.log('[finalize] cobranca criada', {
    orderId,
    customerPhone,
    total,
    provider: charge.provider,
    paymentId: charge.id
  });

  return {
    order_id: orderId,
    total,
    charge: {
      id: charge.id,
      provider: charge.provider,
      status: charge.status,
      payment_link: charge.payment_link,
      pix_copy_paste: charge.pix_copy_paste,
      pix_qr_image: charge.pix_qr_image
    },
    message_sent: Boolean(sendResult)
  };
}

async function resolvePaymentNotification(body) {
  const parsed = parsePaymentWebhook(body);

  if (!parsed) return null;

  if (parsed.provider === 'mercadopago' && parsed.paymentId) {
    try {
      return await fetchMercadoPagoPayment(parsed.paymentId);
    } catch (error) {
      console.error('[webhook/payment] falha consultando MP', error.message);
      return parsed;
    }
  }

  return parsed;
}

export async function runPaymentWebhookPipeline(body) {
  await purgeExpiredPendingPayments();

  const notification = await resolvePaymentNotification(body);

  if (!notification) {
    console.log('[webhook/payment] payload nao reconhecido, ignorando');
    return { ignored: true };
  }

  if (!notification.isPaid) {
    console.log('[webhook/payment] evento nao e de pagamento aprovado', {
      paymentId: notification.paymentId,
      status: notification.status
    });
    return { ignored: true, status: notification.status };
  }

  const orderId = notification.externalReference;

  if (!orderId) {
    console.warn('[webhook/payment] pagamento aprovado sem externalReference', {
      paymentId: notification.paymentId
    });
    return { ignored: true, reason: 'missing_external_reference' };
  }

  const pending = await getPendingPayment(orderId);

  if (!pending) {
    console.warn('[webhook/payment] pedido nao encontrado para pagamento', { orderId });
    return { ignored: true, reason: 'pending_payment_not_found', orderId };
  }

  let invoiceResult = null;
  try {
    invoiceResult = await issueInvoice({
      externalReference: orderId,
      customer: pending.customer,
      items: pending.items,
      total: pending.total
    });

    console.log('[webhook/payment] nota fiscal emitida', {
      orderId,
      provider: invoiceResult.provider,
      status: invoiceResult.status,
      url: invoiceResult.url
    });
  } catch (error) {
    console.error('[webhook/payment] falha ao emitir nota fiscal', {
      orderId,
      error: error.message,
      details: error.details
    });
  }

  const messageLines = [
    `Pagamento do pedido ${orderId} confirmado! ✅`,
    'Obrigado pela compra.'
  ];

  if (invoiceResult?.url) {
    messageLines.push('', `Nota fiscal: ${invoiceResult.url}`);
  } else if (invoiceResult) {
    messageLines.push('', 'Sua nota fiscal esta sendo emitida e chega aqui em instantes.');
  }

  try {
    await sendTextMessage({
      to: pending.customerPhone,
      text: messageLines.join('\n'),
      instance: pending.instance
    });
  } catch (error) {
    console.error('[webhook/payment] falha ao enviar confirmacao pelo WhatsApp', {
      orderId,
      error: error.message
    });
  }

  await clearPendingPayment(orderId);

  return {
    order_id: orderId,
    payment: {
      id: notification.paymentId,
      provider: notification.provider,
      status: notification.status,
      amount: notification.amount
    },
    invoice: invoiceResult
  };
}
