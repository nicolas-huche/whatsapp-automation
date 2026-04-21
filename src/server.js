import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { routeMediaToText, detectMessageType, extractCustomerPhone } from './services/media-router.js';
import { parseOrderText } from './services/order-parser.js';
import { toPublicError } from './errors.js';

const app = Fastify({
  logger: false,
  bodyLimit: Number(process.env.BODY_LIMIT_BYTES || 25 * 1024 * 1024)
});

await app.register(cors, {
  origin: true
});

app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_request, body, done) => {
  done(null, body);
});

app.setErrorHandler((error, request, reply) => {
  const publicError = toPublicError(error);
  console.error('[erro]', {
    route: request.url,
    message: error.message,
    details: error.details
  });

  reply.status(publicError.statusCode).send(publicError);
});

app.get('/health', async () => ({
  status: 'ok',
  service: 'whatsapp-order-automation',
  timestamp: new Date().toISOString(),
  uptime_seconds: Math.round(process.uptime())
}));

async function handleWebhookMessages(request, reply) {
  const payload = request.body;
  const receivedAt = new Date().toISOString();

  console.log('[webhook] mensagem recebida', {
    receivedAt,
    event: payload?.event,
    instance: payload?.instance,
    messageId: payload?.data?.key?.id,
    customerPhone: extractCustomerPhone(payload)
  });

  const detectedType = detectMessageType(payload);
  console.log('[media] tipo detectado', detectedType);

  const mediaResult = await routeMediaToText(payload);
  console.log('[media] texto extraido', mediaResult.text);

  const order = await parseOrderText({
    text: mediaResult.text,
    customerPhone: mediaResult.customerPhone
  });

  console.log('[order] pedido estruturado', JSON.stringify(order, null, 2));

  reply.send(order);
}

app.post('/webhook/messages', handleWebhookMessages);
app.post('/webhook/messages-upsert', handleWebhookMessages);

app.post('/test/parse', async (request, reply) => {
  const text = typeof request.body === 'string' ? request.body : request.body?.text;
  const customerPhone = typeof request.body === 'object' ? request.body?.customer_phone ?? null : null;

  console.log('[test/parse] texto recebido', text);

  const order = await parseOrderText({
    text,
    customerPhone
  });

  console.log('[test/parse] pedido estruturado', JSON.stringify(order, null, 2));

  reply.send(order);
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

try {
  await app.listen({ port, host });
  console.log(`[server] ouvindo em http://${host}:${port}`);
} catch (error) {
  console.error('[server] falha ao iniciar', error);
  process.exit(1);
}
