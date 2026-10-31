/**
 * DocuPulse Full-Stack Server
 * Hosts Express REST API and mounts Vite middlewares on port 3000.
 */

import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const { apiRouter, safeErrorHandler } = await import('./src/services/api/routes.ts');
  const app = express();
  const server = http.createServer(app);
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const isProd = process.env.NODE_ENV === 'production';

  app.use(express.json({ limit: '1mb' }));

  // Mount API router
  app.use(apiRouter);

  // Vite development integration or static dist serving
  if (!isProd) {
    const { createServer } = await import('vite');
    const isHttpsPreview = Boolean(
      process.env.APP_URL && process.env.APP_URL.startsWith('https://')
    );
    const wsConfig = {
      server,
      ...(isHttpsPreview ? { clientPort: 443 } : {}),
    };

    const vite = await createServer({
      server: {
        middlewareMode: true,
        ws: wsConfig,
        hmr: wsConfig,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  // Safe error handling (no stack traces, no leaked secrets)
  app.use(safeErrorHandler);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[DocuPulse Server] Running on http://localhost:${PORT}`);
    console.log(`[DocuPulse Server] Health check: http://localhost:${PORT}/health`);
    console.log(`[DocuPulse Server] OpenAPI schema: http://localhost:${PORT}/api/v1/openapi.json`);
  });
}

startServer().catch(err => {
  console.error('[DocuPulse Server] Startup failure:', err);
  process.exit(1);
});
