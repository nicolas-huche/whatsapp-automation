import { AppError } from '../errors.js';

function chooseProvider() {
  const explicit = process.env.INVOICE_PROVIDER?.trim().toLowerCase();

  if (explicit === 'focusnfe' || explicit === 'enotas') return explicit;
  if (process.env.FOCUSNFE_API_KEY?.trim()) return 'focusnfe';
  if (process.env.ENOTAS_API_KEY?.trim()) return 'enotas';

  throw new AppError('Nenhum provider de NF-e configurado (FOCUSNFE_API_KEY ou ENOTAS_API_KEY).', 500);
}

function onlyDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function mapItemsForFocus(items) {
  return items.map((item, index) => {
    const quantity = Number(item.quantity) || 1;
    const unitPrice = Number(item.unit_price) || 0;

    return {
      numero_item: index + 1,
      codigo_produto: item.code || String(index + 1),
      descricao: item.product_name || item.product || 'Produto',
      cfop: process.env.INVOICE_CFOP || '5102',
      unidade_comercial: (item.unit || 'UN').toUpperCase(),
      quantidade_comercial: quantity,
      valor_unitario_comercial: unitPrice,
      valor_unitario_tributavel: unitPrice,
      unidade_tributavel: (item.unit || 'UN').toUpperCase(),
      quantidade_tributavel: quantity,
      valor_bruto: round2(quantity * unitPrice),
      ncm: item.ncm || process.env.INVOICE_DEFAULT_NCM || '00000000',
      icms_origem: '0',
      icms_situacao_tributaria: process.env.INVOICE_ICMS_CST || '102'
    };
  });
}

async function issueFocusNfe({ externalReference, customer, items, total }) {
  const baseUrl = (process.env.FOCUSNFE_API_URL || 'https://api.focusnfe.com.br').replace(/\/+$/, '');
  const auth = Buffer.from(`${process.env.FOCUSNFE_API_KEY}:`).toString('base64');
  const document = onlyDigits(customer?.document);

  const body = {
    natureza_operacao: process.env.INVOICE_NATUREZA || 'Venda de mercadoria',
    data_emissao: new Date().toISOString(),
    tipo_documento: '1',
    finalidade_emissao: '1',
    cnpj_emitente: onlyDigits(process.env.INVOICE_EMITTER_CNPJ),
    nome_destinatario: customer?.name || 'Consumidor Final',
    cpf_destinatario: document && document.length <= 11 ? document : undefined,
    cnpj_destinatario: document && document.length > 11 ? document : undefined,
    telefone_destinatario: onlyDigits(customer?.phone) || undefined,
    email_destinatario: customer?.email || undefined,
    presenca_comprador: '9',
    items: mapItemsForFocus(items),
    valor_total: round2(total)
  };

  const response = await fetch(`${baseUrl}/v2/nfce?ref=${encodeURIComponent(externalReference)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${auth}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => null);

  if (!response.ok && response.status !== 202) {
    throw new AppError('Focus NFe rejeitou a emissao.', 502, {
      status: response.status,
      body: data
    });
  }

  return {
    provider: 'focusnfe',
    reference: externalReference,
    status: data?.status || 'processando',
    number: data?.numero || null,
    series: data?.serie || null,
    url: data?.url || data?.url_danfe || null,
    raw: data
  };
}

async function issueEnotas({ externalReference, customer, items, total }) {
  const baseUrl = (process.env.ENOTAS_API_URL || 'https://api.enotasgw.com.br').replace(/\/+$/, '');
  const companyId = process.env.ENOTAS_COMPANY_ID;

  if (!companyId) {
    throw new AppError('ENOTAS_COMPANY_ID nao configurado.', 500);
  }

  const document = onlyDigits(customer?.document);

  const body = {
    idExterno: externalReference,
    dataEmissao: new Date().toISOString(),
    valorTotal: round2(total),
    cliente: {
      nome: customer?.name || 'Consumidor Final',
      email: customer?.email || undefined,
      cpfCnpj: document || undefined,
      telefone: onlyDigits(customer?.phone) || undefined,
      consumidorFinal: true
    },
    servico: {
      discriminacao: items.map((item) => `${item.quantity || 1} ${item.unit || 'un'} ${item.product_name || item.product}`).join(' | '),
      valorTotal: round2(total),
      valorIss: 0
    }
  };

  const response = await fetch(`${baseUrl}/v2/empresas/${encodeURIComponent(companyId)}/nfes`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${process.env.ENOTAS_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new AppError('eNotas rejeitou a emissao.', 502, {
      status: response.status,
      body: data
    });
  }

  return {
    provider: 'enotas',
    reference: externalReference,
    status: data?.status || 'processando',
    number: data?.numero || null,
    series: data?.serie || null,
    url: data?.linkDownloadPdf || data?.link_danfe || null,
    raw: data
  };
}

export async function issueInvoice({ externalReference, customer, items, total }) {
  if (!externalReference) {
    throw new AppError('externalReference obrigatorio para emitir NF-e.', 422);
  }

  if (!Array.isArray(items) || !items.length) {
    throw new AppError('Pedido sem itens para emitir NF-e.', 422);
  }

  if (!total || Number(total) <= 0) {
    throw new AppError('Valor total obrigatorio para emitir NF-e.', 422);
  }

  const provider = chooseProvider();

  if (provider === 'focusnfe') {
    return issueFocusNfe({ externalReference, customer, items, total });
  }

  if (provider === 'enotas') {
    return issueEnotas({ externalReference, customer, items, total });
  }

  throw new AppError(`Provider de NF-e desconhecido: ${provider}`, 500);
}
