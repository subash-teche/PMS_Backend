import fp from 'fastify-plugin';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from '../config/env.js';

// Security headers, CORS for the React app, and a global rate limit
// (routes can tighten it with `config: { rateLimit: {...} }`, e.g. login).
async function securityPlugin(fastify) {
  // Security headers on every response. Only the Swagger UI (/docs) needs inline scripts/styles,
  // so the content-security-policy is relaxed there and strict for the JSON API.
  await fastify.register(helmet, { global: false });
  fastify.addHook('onRequest', async (req, reply) => {
    const docs = req.url.startsWith('/docs');
    await reply.helmet(docs ? { contentSecurityPolicy: false } : undefined);
  });

  await fastify.register(cors, {
    origin: config.corsOrigins,
    credentials: true, // refresh-token cookie
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await fastify.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
  });
}

export default fp(securityPlugin, { name: 'security' });
