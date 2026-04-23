import { AppError } from '../errors.js';

function chooseProvider() {
  const explicit = process.env.BILLING_PROVIDER?.trim().toLowerCase();

  if (explicit === 'asaas' || explicit === 'mercadopago') return explicit;
  if (process.env.ASAAS_API_KEY?.trim()) return 'asaas';
  if (process.env.MERCADOPAGO_ACCESS_TOKEN?.trim()) return 'mercadopago';

  throw new AppError('Nenhum provider de cobranca configurado (ASAAS_API_KEY ou MERCADOPAGO_ACCESS_TOKEN).', 500);
}

function daysFromNow(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function centsFromAmount(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError('Valor da cobranca invalido.', 422, { amount });
  }
  return Math.round(value * 100);
}

function onlyDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

async function asaasRequest(path, { method = 'GET', body } = {}) {
  const baseUrl = (process.env.ASAAS_API_URL || 'https://api.asaas.com/v3').replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      access_token: process.env.ASAAS_API_KEY
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new AppError('Asaas rejeitou a requisicao.', 502, {
      status: response.status,
      path,
      body: data
    });
  }

  return data;
}

async function findOrCreateAsaasCustomer({ name, document, phone, email }) {
  const cleanDocument = onlyDigits(document);
  const cleanPhone = onlyDigits(phone);

  if (cleanDocument) {
    const existing = await asaasRequest(`/customers?cpfCnpj=${cleanDocument}`);
    if (existing?.data?.length) return existing.data[0];
  }

  return asaasRequest('/customers', {
    method: 'POST',
    body: {
      name: name || 'Cliente WhatsApp',
      cpfCnpj: cleanDocument || undefined,
      mobilePhone: cleanPhone || undefined,
      email: email || undefined
    }
  });
}

async function createAsaasPix({ externalReference, amount, description, customer }) {
  const asaasCustomer = await findOrCreateAsaasCustomer(customer);
  const dueDate = daysFromNow(Number(process.env.BILLING_DUE_DAYS || 3));

  const payment = await asaasRequest('/payments', {
    method: 'POST',
    body: {
      customer: asaasCustomer.id,
      billingType: 'PIX',
      value: Number(amount),
      dueDate,
      description,
      externalReference
    }
  });

  let pix = null;
  try {
    pix = await asaasRequest(`/payments/${payment.id}/pixQrCode`);
  } catch (error) {
    console.error('[billing] falha ao buscar QR pix Asaas', error.message);
  }

  return {
    id: payment.id,
    provider: 'asaas',
    status: payment.status,
    amount: Number(amount),
    due_date: payment.dueDate,
    payment_link: payment.invoiceUrl || payment.bankSlipUrl,
    pix_copy_paste: pix?.payload || null,
    pix_qr_image: pix?.encodedImage ? `data:image/png;base64,${pix.encodedImage}` : null,
    raw: payment
  };
}

async function createMercadoPagoPix({ externalReference, amount, description, customer }) {
  const baseUrl = (process.env.MERCADOPAGO_API_URL || 'https://api.mercadopago.com').replace(/\/+$/, '');

  const response = await fetch(`${baseUrl}/v1/payments`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}`,
      'x-idempotency-key': externalReference
    },
    body: JSON.stringify({
      transaction_amount: Number(amount),
      description: description || 'Pedido WhatsApp',
      payment_method_id: 'pix',
      external_reference: externalReference,
      payer: {
        email: customer?.email || `${onlyDigits(customer?.phone) || externalReference}@whatsapp.bot`,
        first_name: customer?.name || 'Cliente',
        identification: customer?.document
          ? { type: onlyDigits(customer.document).length > 11 ? 'CNPJ' : 'CPF', number: onlyDigits(customer.document) }
          : undefined
      }
    })
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new AppError('Mercado Pago rejeitou a cobranca.', 502, {
      status: response.status,
      body: data
    });
  }

  const poi = data?.point_of_interaction?.transaction_data || {};

  return {
    id: String(data.id),
    provider: 'mercadopago',
    status: data.status,
    amount: Number(amount),
    due_date: data.date_of_expiration || null,
    payment_link: poi.ticket_url || null,
    pix_copy_paste: poi.qr_code || null,
    pix_qr_image: poi.qr_code_base64 ? `data:image/png;base64,${poi.qr_code_base64}` : null,
    raw: data
  };
}

export async function createPixCharge(input) {
  if (!input?.externalReference) {
    throw new AppError('externalReference obrigatorio para criar cobranca.', 422);
  }

  if (!input?.amount || Number(input.amount) <= 0) {
    throw new AppError('Valor da cobranca obrigatorio.', 422);
  }

  centsFromAmount(input.amount);

  const provider = chooseProvider();

  if (provider === 'asaas') return createAsaasPix(input);
  if (provider === 'mercadopago') return createMercadoPagoPix(input);

  throw new AppError(`Provider de cobranca desconhecido: ${provider}`, 500);
}

export function parsePaymentWebhook(payload) {
  if (!payload || typeof payload !== 'object') return null;

  if (payload.event && (payload.event.startsWith('PAYMENT_') || payload.event.includes('payment'))) {
    const payment = payload.payment || payload.data || {};
    const status = String(payment.status || '').toUpperCase();
    const isPaid = ['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH', 'PAID'].includes(status);

    return {
      provider: 'asaas',
      paymentId: payment.id || null,
      externalReference: payment.externalReference || null,
      status: payment.status || null,
      isPaid,
      amount: Number(payment.value ?? payment.netValue ?? 0) || null,
      raw: payload
    };
  }

  if (payload.type === 'payment' || payload.action === 'payment.updated' || payload.action === 'payment.created') {
    return {
      provider: 'mercadopago',
      paymentId: payload.data?.id ? String(payload.data.id) : null,
      externalReference: null,
      status: null,
      isPaid: false,
      amount: null,
      raw: payload
    };
  }

  return null;
}

export async function fetchMercadoPagoPayment(paymentId) {
  const baseUrl = (process.env.MERCADOPAGO_API_URL || 'https://api.mercadopago.com').replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: {
      authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}`
    }
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new AppError('Falha ao consultar pagamento no Mercado Pago.', 502, {
      status: response.status,
      body: data
    });
  }

  const status = String(data?.status || '').toLowerCase();

  return {
    provider: 'mercadopago',
    paymentId: String(data.id),
    externalReference: data.external_reference || null,
    status: data.status,
    isPaid: status === 'approved',
    amount: Number(data.transaction_amount) || null,
    raw: data
  };
}
