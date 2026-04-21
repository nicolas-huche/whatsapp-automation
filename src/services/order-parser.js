import OpenAI from 'openai';
import { catalog } from '../config/catalog.js';
import { AppError } from '../errors.js';
import { buildOrderPrompt } from '../prompts/order-prompt.js';

let openaiClient;

const orderSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    customer_phone: { type: ['string', 'null'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          product_id: { type: ['integer', 'null'] },
          product_name: { type: 'string' },
          quantity: { type: 'number' },
          unit: { type: 'string' },
          unit_price: { type: 'number' },
          subtotal: { type: 'number' },
          unit_was_inferred: { type: 'boolean' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          inference_reason: { type: 'string' }
        },
        required: [
          'product_id',
          'product_name',
          'quantity',
          'unit',
          'unit_price',
          'subtotal',
          'unit_was_inferred',
          'confidence',
          'inference_reason'
        ]
      }
    },
    total: { type: 'number' },
    ambiguities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          product_name: { type: 'string' },
          question: { type: 'string' },
          options: {
            type: 'array',
            items: { type: 'string' }
          }
        },
        required: ['product_name', 'question', 'options']
      }
    },
    original_text: { type: 'string' }
  },
  required: ['customer_phone', 'items', 'total', 'ambiguities', 'original_text']
};

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new AppError('OPENAI_API_KEY nao configurada para parsear pedido.', 500);
  }

  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  return openaiClient;
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function normalizeUnit(unit) {
  const value = normalizeText(unit);

  if (['kg', 'kgs', 'quilo', 'quilos'].includes(value)) return 'kg';
  if (['g', 'gr', 'grama', 'gramas'].includes(value)) return 'g';
  if (['un', 'und', 'unid', 'unidade', 'unidades', 'cabeca', 'cabecas'].includes(value)) return 'unidade';
  if (['duzia', 'duzias'].includes(value)) return 'duzia';
  if (['maco', 'macos', 'molho', 'molhos'].includes(value)) return 'maco';

  return value || 'unidade';
}

function money(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function buildCatalogIndexes() {
  const byId = new Map();
  const byAlias = new Map();

  for (const product of catalog) {
    byId.set(product.id, product);

    for (const alias of [product.name, product.display_name, ...product.aliases].filter(Boolean)) {
      byAlias.set(normalizeText(alias), product);
    }
  }

  return { byId, byAlias };
}

function findProduct(item, indexes) {
  if (item.product_id && indexes.byId.has(item.product_id)) {
    return indexes.byId.get(item.product_id);
  }

  const normalizedName = normalizeText(item.product_name);
  if (indexes.byAlias.has(normalizedName)) {
    return indexes.byAlias.get(normalizedName);
  }

  for (const [alias, product] of indexes.byAlias.entries()) {
    if (normalizedName.includes(alias) || alias.includes(normalizedName)) {
      return product;
    }
  }

  return null;
}

function addAmbiguity(ambiguities, ambiguity) {
  const key = `${normalizeText(ambiguity.product_name)}|${normalizeText(ambiguity.question)}`;
  const exists = ambiguities.some((item) => `${normalizeText(item.product_name)}|${normalizeText(item.question)}` === key);

  if (!exists) {
    ambiguities.push(ambiguity);
  }
}

function normalizeOrder(parsed, { customerPhone, originalText }) {
  const indexes = buildCatalogIndexes();
  const ambiguities = Array.isArray(parsed.ambiguities) ? [...parsed.ambiguities] : [];
  const normalizedItems = [];

  for (const item of Array.isArray(parsed.items) ? parsed.items : []) {
    const product = findProduct(item, indexes);
    const quantity = Number(item.quantity) || 0;

    if (!product) {
      const unknownProductName = item.product_name || 'Produto nao identificado';

      normalizedItems.push({
        product_id: null,
        product_name: unknownProductName,
        quantity,
        unit: item.unit || 'unidade',
        unit_price: 0,
        subtotal: 0,
        unit_was_inferred: Boolean(item.unit_was_inferred),
        confidence: Math.min(Number(item.confidence) || 0.2, 0.2),
        inference_reason: 'Produto nao encontrado no catalogo.'
      });

      addAmbiguity(ambiguities, {
        product_name: unknownProductName,
        question: `Nao encontrei "${unknownProductName}" no catalogo. Qual produto voce quis pedir?`,
        options: []
      });

      continue;
    }

    const unit = normalizeUnit(item.unit || product.default_unit || 'unidade');
    let unitPrice = product.prices?.[unit];

    if (unit === 'g' && product.prices?.kg) {
      unitPrice = product.prices.kg / 1000;
    }

    if (typeof unitPrice !== 'number') {
      unitPrice = 0;
      addAmbiguity(ambiguities, {
        product_name: product.display_name ?? product.name,
        question: `Nao encontrei preco para ${product.display_name ?? product.name} em ${unit}. Qual unidade devo usar?`,
        options: Object.keys(product.prices ?? {})
      });
    }

    if (product.ambiguous_when_unit_missing && item.unit_was_inferred) {
      addAmbiguity(ambiguities, {
        product_name: product.display_name ?? product.name,
        question: `Voce quis dizer ${quantity}kg ou ${quantity} unidades de ${(product.display_name ?? product.name).toLowerCase()}?`,
        options: [`${quantity} kg`, `${quantity} unidades`]
      });
    }

    normalizedItems.push({
      product_id: product.id,
      product_name: product.display_name ?? product.name,
      quantity,
      unit,
      unit_price: money(unitPrice),
      subtotal: money(quantity * unitPrice),
      unit_was_inferred: Boolean(item.unit_was_inferred),
      confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 0.7,
      inference_reason: item.inference_reason || product.inference_hint
    });
  }

  const total = money(normalizedItems.reduce((sum, item) => sum + item.subtotal, 0));

  return {
    customer_phone: customerPhone ?? parsed.customer_phone ?? null,
    items: normalizedItems,
    total,
    ambiguities,
    original_text: originalText
  };
}

export async function parseOrderText({ text, customerPhone = null }) {
  if (!text?.trim()) {
    throw new AppError('Texto do pedido vazio.', 422);
  }

  const model = process.env.OPENAI_ORDER_MODEL || 'gpt-4o';

  try {
    const completion = await getOpenAIClient().chat.completions.create({
      model,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: buildOrderPrompt(catalog)
        },
        {
          role: 'user',
          content: JSON.stringify({
            customer_phone: customerPhone,
            original_text: text.trim()
          })
        }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'structured_whatsapp_order',
          strict: true,
          schema: orderSchema
        }
      }
    });

    const rawContent = completion.choices[0]?.message?.content;

    if (!rawContent) {
      throw new AppError('OpenAI nao retornou conteudo para o parser de pedido.', 502);
    }

    return normalizeOrder(JSON.parse(rawContent), {
      customerPhone,
      originalText: text.trim()
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (error instanceof SyntaxError) {
      throw new AppError('Parser retornou JSON invalido.', 502, error.message);
    }

    throw new AppError('Falha ao parsear pedido com OpenAI.', 502, error.message);
  }
}
