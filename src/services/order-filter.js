import OpenAI from 'openai';
import { AppError } from '../errors.js';

let openaiClient;

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new AppError('OPENAI_API_KEY nao configurada para filtrar pedidos.', 500);
  }

  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  return openaiClient;
}

export async function isPurchaseOrder(text) {
  if (!text?.trim()) return false;

  const model = process.env.OPENAI_FILTER_MODEL || process.env.OPENAI_ORDER_FILTER_MODEL || 'gpt-4o-mini';

  try {
    const completion = await getOpenAIClient().chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 3,
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

    const answer = completion.choices[0]?.message?.content?.trim().toUpperCase() || '';
    return answer.startsWith('SIM');
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('Falha ao classificar mensagem como pedido.', 502, error.message);
  }
}
