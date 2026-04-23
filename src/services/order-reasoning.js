import OpenAI from 'openai';
import { AppError } from '../errors.js';

let openaiClient;

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new AppError('OPENAI_API_KEY nao configurada para estruturar pedidos.', 500);
  }

  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  return openaiClient;
}

function clampConfidence(value, fallback = 0) {
  const number = Number(value);

  if (!Number.isFinite(number)) return fallback;
  if (number < 0) return 0;
  if (number > 1) return 1;

  return number;
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function parseQuantity(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;

  const normalized = value.replace(',', '.').match(/\d+(?:\.\d+)?/);
  return normalized ? Number(normalized[0]) : null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function normalizedKey(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.\s_-]+/g, '');
}

function normalizeUnit(value) {
  if (!value) return null;

  const aliases = {
    kg: 'kg',
    quilo: 'kg',
    quilos: 'kg',
    kilo: 'kg',
    kilos: 'kg',
    g: 'g',
    grama: 'g',
    gramas: 'g',
    un: 'un',
    und: 'un',
    unid: 'un',
    unidade: 'un',
    unidades: 'un',
    peca: 'un',
    pecas: 'un',
    cx: 'cx',
    caixa: 'cx',
    caixas: 'cx',
    pct: 'pct',
    pacote: 'pct',
    pacotes: 'pct',
    fardo: 'fardo',
    fardos: 'fardo',
    maco: 'maco',
    macos: 'maco',
    dz: 'dz',
    duzia: 'dz',
    duzias: 'dz',
    l: 'l',
    litro: 'l',
    litros: 'l',
    ml: 'ml',
    mililitro: 'ml',
    mililitros: 'ml'
  };

  return aliases[normalizedKey(value)] || String(value).trim().toLowerCase();
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return fallback;

  const normalized = normalizedKey(value);
  if (['true', 'sim', 'yes', '1'].includes(normalized)) return true;
  if (['false', 'nao', 'no', '0'].includes(normalized)) return false;

  return fallback;
}

function normalizeItem(item) {
  const product = firstDefined(item.product_name, item.product, item.produto, item.name, item.nome);
  const unit = firstDefined(item.unit, item.unidade);
  const quantity = parseQuantity(firstDefined(item.quantity, item.quantidade, item.qty));
  const ambiguities = asArray(firstDefined(item.ambiguities, item.ambiguidades));
  const productName = String(product ?? '').trim().toLowerCase();
  const unitWasInferred = firstDefined(item.unit_was_inferred, item.unidade_inferida, false);
  const inferenceReason = firstDefined(item.inference_reason, item.motivo_inferencia, item.reason);

  return {
    product_name: productName,
    product: productName,
    quantity,
    unit: normalizeUnit(unit),
    unit_was_inferred: parseBoolean(unitWasInferred),
    inference_reason: inferenceReason ? String(inferenceReason).trim() : null,
    confidence: clampConfidence(firstDefined(item.confidence, item.confianca), ambiguities.length ? 0.55 : 0.75),
    ambiguities
  };
}

function normalizeOrder(raw) {
  const rawItems = firstDefined(raw.items, raw.itens, raw.products, raw.produtos);
  const items = Array.isArray(rawItems)
    ? rawItems.map(normalizeItem).filter((item) => item.product_name)
    : [];
  const itemConfidences = items.map((item) => item.confidence);
  const fallbackConfidence = itemConfidences.length
    ? Math.min(...itemConfidences)
    : 0;
  const ambiguities = asArray(firstDefined(raw.ambiguities, raw.ambiguidades));
  const clarificationQuestions = asArray(firstDefined(
    raw.clarification_questions,
    raw.perguntas_clarificacao,
    raw.perguntas
  ));

  return {
    items,
    confidence: clampConfidence(firstDefined(raw.confidence, raw.confianca), fallbackConfidence),
    ambiguities,
    needs_clarification: Boolean(firstDefined(raw.needs_clarification, raw.precisa_clarificacao, false)),
    clarification_questions: clarificationQuestions
  };
}

function cleanJsonText(text) {
  return String(text ?? '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

function buildUserPrompt(text, context) {
  const parts = [
    `Texto recebido agora: ${text.trim()}`
  ];

  if (context?.order) {
    parts.push(`Pedido parcial anterior: ${JSON.stringify(context.order)}`);
  }

  if (context?.pendingQuestions?.length) {
    parts.push(`Perguntas pendentes enviadas ao cliente: ${JSON.stringify(context.pendingQuestions)}`);
  }

  if (context?.clarificationAnswer) {
    parts.push(`Resposta de clarificacao do cliente: ${context.clarificationAnswer}`);
  }

  return parts.join('\n');
}

export async function reasonAboutOrder(text, context = null) {
  if (!text?.trim()) {
    throw new AppError('Texto vazio para estruturar pedido.', 422);
  }

  const model = process.env.OPENAI_ORDER_MODEL || 'gpt-4o';

  try {
    const completion = await getOpenAIClient().chat.completions.create({
      model,
      temperature: 0.1,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'Voce estrutura pedidos de compra recebidos por WhatsApp em JSON valido, sem markdown.',
            'Schema obrigatorio: {"items":[{"product_name":"nome","quantity":numero|null,"unit":"kg|g|un|cx|pct|fardo|maco|dz|l|ml|null","unit_was_inferred":boolean,"inference_reason":"texto|null","confidence":0-1,"ambiguities":["..."]}],"confidence":0-1,"ambiguities":["..."],"needs_clarification":boolean,"clarification_questions":["..."]}.',
            'Use nomes de produtos em portugues, minusculos e sem inventar itens.',
            'Converta quantidades para numero com ponto decimal. Preserve a unidade informada quando existir.',
            'Inferencias permitidas: quilo/kilo/kg => kg; grama/g => g; unidade/unid/peca => un; caixa/cx => cx; pacote/pct => pct; duzia/dz => dz; litro/l => l; mililitro/ml => ml.',
            'Sempre preencha unit_was_inferred e inference_reason: use true quando a unidade nao foi dita literalmente e voce precisou inferir; use false e inference_reason null quando a unidade foi dita.',
            'Se o cliente disser "2 limao", "3 cebola" ou item contavel sem unidade explicita, use unit "un", unit_was_inferred true, explique em inference_reason e reduza confidence se o produto tambem costuma ser vendido por peso ou caixa.',
            'Se quantidade ou unidade estiver ausente, ambigua, contraditoria ou depender de confirmacao comercial, use confidence baixo, descreva em ambiguities e gere uma pergunta curta em clarification_questions.',
            'Se houver pedido parcial anterior e uma resposta de clarificacao, mescle a resposta no pedido anterior e preserve os itens ja confirmados.'
          ].join(' ')
        },
        {
          role: 'user',
          content: buildUserPrompt(text, context)
        }
      ]
    });

    const rawText = completion.choices[0]?.message?.content;

    if (!rawText?.trim()) {
      throw new AppError('OpenAI nao retornou JSON para o pedido.', 502);
    }

    const parsed = JSON.parse(cleanJsonText(rawText));
    const order = normalizeOrder(parsed);

    if (!order.items.length) {
      throw new AppError('Nao foi possivel extrair itens do pedido.', 422, { text });
    }

    return order;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (error instanceof SyntaxError) {
      throw new AppError('OpenAI retornou JSON invalido para o pedido.', 502, error.message);
    }

    throw new AppError('Falha ao estruturar pedido com OpenAI.', 502, error.message);
  }
}
