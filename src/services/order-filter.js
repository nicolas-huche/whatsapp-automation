import { AppError } from '../errors.js';
import { getOpenAIClient } from './openai-client.js';

function normalizeAnswer(raw) {
  return String(raw ?? '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z]/g, '');
}

function classify(rawAnswer) {
  const normalized = normalizeAnswer(rawAnswer);

  if (!normalized) return 'unknown';
  if (normalized.startsWith('SIM') || normalized.startsWith('YES')) return 'yes';
  if (normalized.startsWith('NAO') || normalized.startsWith('NO')) return 'no';

  return 'unknown';
}

export async function isPurchaseOrder(text) {
  if (!text?.trim()) return false;

  const model = process.env.OPENAI_FILTER_MODEL || process.env.OPENAI_ORDER_FILTER_MODEL || 'gpt-4o-mini';

  try {
    const completion = await getOpenAIClient().chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 5,
      messages: [
        {
          role: 'system',
          content: 'Responda somente SIM ou NAO. O texto e um pedido de compra? SIM se mencionar produtos, itens ou quantidades, mesmo que comece com saudacao como oi, bom dia, boa tarde. NAO apenas se for conversa sem nenhum produto ou item mencionado.'
        },
        {
          role: 'user',
          content: text.trim()
        }
      ]
    });

    const rawAnswer = completion.choices[0]?.message?.content || '';
    const decision = classify(rawAnswer);

    if (decision === 'unknown') {
      console.warn('[order-filter] resposta inesperada do modelo, assumindo pedido', {
        rawAnswer,
        text: text.slice(0, 120)
      });
      return true;
    }

    return decision === 'yes';
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('Falha ao classificar mensagem como pedido.', 502, error.message);
  }
}
