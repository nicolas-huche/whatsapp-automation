import { sendTextMessage } from './whatsapp-sender.js';

export function confidenceThreshold() {
  const threshold = Number(process.env.ORDER_CONFIDENCE_THRESHOLD || 0.8);

  if (!Number.isFinite(threshold)) return 0.8;
  if (threshold < 0) return 0;
  if (threshold > 1) return 1;

  return threshold;
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
