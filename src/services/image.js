import { AppError } from '../errors.js';
import { getOpenAIClient } from './openai-client.js';

export async function interpretImage(media, caption = '') {
  const model = process.env.OPENAI_VISION_MODEL || 'gpt-4o';
  const mimeType = media.mimeType || 'image/jpeg';
  const base64Image = media.buffer.toString('base64');

  try {
    const completion = await getOpenAIClient().chat.completions.create({
      model,
      temperature: 0.1,
      max_tokens: 800,
      messages: [
        {
          role: 'system',
          content: 'Voce interpreta imagens recebidas por WhatsApp e transforma o conteudo visivel em texto natural de um pedido de compra. Se a imagem nao estiver legivel ou nao tiver pedido, responda exatamente IMAGEM_ILEGIVEL.'
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                'Transcreva e interprete o conteudo desta imagem como um pedido de compra.',
                'Se houver lista manuscrita, cupom, print ou foto de anotacao, extraia itens, quantidades e unidades visiveis.',
                caption ? `Legenda enviada junto da imagem: ${caption}` : null
              ].filter(Boolean).join('\n')
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`
              }
            }
          ]
        }
      ]
    });

    const text = completion.choices[0]?.message?.content?.trim();

    if (!text || text === 'IMAGEM_ILEGIVEL') {
      throw new AppError('Imagem nao legivel ou sem pedido identificavel.', 422);
    }

    return text;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('Falha ao interpretar imagem com OpenAI Vision.', 502, error.message);
  }
}
