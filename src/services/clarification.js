import { sendTextMessage } from './whatsapp-sender.js';

const CONFIRMATION_PHRASES = [
  'sim',
  'ok',
  'isso',
  'confirma',
  'confirmo',
  'pode mandar',
  'tudo certo',
  'correto',
  'isso mesmo',
  'perfeito',
  'fechado',
  'manda',
  'positivo'
];

const CANCELLATION_PHRASES = [
  'cancela',
  'cancelar',
  'nao quero',
  'deixa pra la',
  'esquece',
  'nao precisa'
];

const CORRECTION_MARKERS = [
  'nao',
  'errado',
  'incorreto',
  'mas',
  'na verdade',
  'sao',
  'troca',
  'trocar',
  'muda',
  'mudar',
  'corrige',
  'corrigir',
  'quero'
];

export function confidenceThreshold() {
  const threshold = Number(process.env.ORDER_CONFIDENCE_THRESHOLD || 0.8);

  if (!Number.isFinite(threshold)) return 0.8;
  if (threshold < 0) return 0;
  if (threshold > 1) return 1;

  return threshold;
}

function normalizeReplyText(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasPhrase(text, phrases) {
  return phrases.some((phrase) => {
    const normalizedPhrase = normalizeReplyText(phrase);
    return text === normalizedPhrase || text.includes(` ${normalizedPhrase} `) || text.startsWith(`${normalizedPhrase} `) || text.endsWith(` ${normalizedPhrase}`);
  });
}

export function isConfirmationReply(text) {
  const normalized = normalizeReplyText(text);

  if (!normalized || /\d/.test(normalized)) return false;
  if (hasPhrase(normalized, CANCELLATION_PHRASES)) return false;
  if (hasPhrase(normalized, CORRECTION_MARKERS)) return false;

  const words = normalized.split(' ').filter(Boolean);
  if (words.length > 5) return false;

  return hasPhrase(normalized, CONFIRMATION_PHRASES);
}

export function isCancellationReply(text) {
  const normalized = normalizeReplyText(text);

  if (!normalized) return false;

  return hasPhrase(normalized, CANCELLATION_PHRASES);
}

export function itemsNeedingClarification(order, threshold = confidenceThreshold()) {
  return (order?.items || []).filter((item) => (
    Number(item.confidence ?? 0) < threshold ||
    !item.quantity ||
    !item.unit ||
    item.ambiguities?.length
  ));
}

export function orderNeedsClarification(order, threshold = confidenceThreshold()) {
  return Boolean(
    order?.needs_clarification ||
    Number(order?.confidence ?? 0) < threshold ||
    order?.ambiguities?.length ||
    itemsNeedingClarification(order, threshold).length
  );
}

function describeItem(item) {
  const quantity = item.quantity ? String(item.quantity).replace('.', ',') : null;
  const productName = item.product_name || item.product;

  if (!quantity && !item.unit) {
    return `${productName} (quantidade e unidade)`;
  }

  if (!quantity) {
    return `${item.unit} ${productName} (quantidade)`;
  }

  if (!item.unit) {
    return `${quantity} ${productName} (unidade)`;
  }

  const parts = [quantity, item.unit, productName];

  return parts.join(' ');
}

function formatOrderItems(order) {
  return (order?.items || [])
    .map((item) => `- ${describeItem(item)}`)
    .join('\n');
}

export function buildClarificationQuestion(order, threshold = confidenceThreshold()) {
  if (order?.clarification_questions?.length) {
    return [
      'Para fechar seu pedido, preciso confirmar:',
      ...order.clarification_questions.slice(0, 3).map((question) => `- ${question}`)
    ].join('\n');
  }

  const lowConfidenceItems = itemsNeedingClarification(order, threshold);

  if (!lowConfidenceItems.length) {
    return 'Pode confirmar os itens, quantidades e unidades do pedido, por favor?';
  }

  const itemList = lowConfidenceItems.slice(0, 4).map(describeItem).join(', ');
  return `Pode confirmar a quantidade/unidade de ${itemList}, por favor?`;
}

export function buildConfirmationRequest(order, heading = 'Seu pedido:') {
  return [
    heading,
    formatOrderItems(order),
    'Esta correto?'
  ].join('\n');
}

export function buildOrderConfirmedMessage(order) {
  return [
    'Pedido confirmado! ✅',
    formatOrderItems(order)
  ].join('\n');
}

export async function sendOrderClarification({
  customerPhone,
  order,
  instance,
  threshold = confidenceThreshold()
}) {
  const question = buildClarificationQuestion(order, threshold);
  const result = await sendTextMessage({
    to: customerPhone,
    text: question,
    instance
  });

  return {
    question,
    result
  };
}

export async function sendOrderConfirmationRequest({
  customerPhone,
  order,
  instance,
  heading = 'Seu pedido:'
}) {
  const message = buildConfirmationRequest(order, heading);
  const result = await sendTextMessage({
    to: customerPhone,
    text: message,
    instance
  });

  return {
    message,
    result
  };
}
