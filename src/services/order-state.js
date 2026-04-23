const orderStates = new Map();

export const ORDER_STATE_STATUS = {
  AWAITING_CLARIFICATION: 'awaiting_clarification',
  AWAITING_CONFIRMATION: 'awaiting_confirmation'
};

function ttlMs() {
  const minutes = Number(process.env.ORDER_STATE_TTL_MINUTES || 30);
  return Math.max(1, minutes) * 60 * 1000;
}

function keyFor(customerPhone) {
  const key = String(customerPhone ?? '').replace(/\D/g, '');
  return key || null;
}

function isExpired(context) {
  return Date.now() > context.expiresAt;
}

export function getOrderState(customerPhone) {
  const key = keyFor(customerPhone);
  if (!key) return null;

  const context = orderStates.get(key);
  if (!context) return null;

  if (isExpired(context)) {
    orderStates.delete(key);
    return null;
  }

  return context;
}

export function hasPendingOrderState(customerPhone) {
  return Boolean(getOrderState(customerPhone));
}

export function saveOrderState(customerPhone, context) {
  const key = keyFor(customerPhone);
  if (!key) return null;

  const now = new Date();
  const existing = orderStates.get(key);
  const next = {
    customerPhone: key,
    status: context.status || existing?.status || ORDER_STATE_STATUS.AWAITING_CLARIFICATION,
    order: context.order,
    pendingQuestions: context.pendingQuestions || [],
    originalText: context.originalText || existing?.originalText || null,
    createdAt: existing?.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: Date.now() + ttlMs()
  };

  orderStates.set(key, next);
  return next;
}

export function clearOrderState(customerPhone) {
  const key = keyFor(customerPhone);
  if (!key) return false;

  return orderStates.delete(key);
}

export function purgeExpiredOrderStates() {
  for (const [key, context] of orderStates.entries()) {
    if (isExpired(context)) {
      orderStates.delete(key);
    }
  }
}
