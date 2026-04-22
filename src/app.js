const express = require('express');
const { randomUUID } = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const webhookRoutes = require('./routes/webhook.routes');
const metricsRoutes = require('./routes/metrics.routes');
const authRoutes = require('./routes/auth.routes');
const debugRoutes = require('./routes/debug.routes');
const debugPhase2Routes = require('./routes/debug.phase2.routes');
const debugWhatsAppRoutes = require('./routes/debug.whatsapp');
const portalRoutes = require('./routes/portal.routes');
const adminRoutes = require('./routes/admin.routes');
const env = require('./config/env');
const buildInfo = require('./utils/build');

function createApp() {
  const app = express();
  // Running behind one reverse proxy/tunnel hop (Cloudflare Tunnel).
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors());
  app.use(morgan('combined'));
  app.use((req, res, next) => {
    const incomingRequestId = String(req.get('x-request-id') || '').trim();
    req.requestId = incomingRequestId || randomUUID();
    res.set('x-request-id', req.requestId);
    next();
  });

  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false
  });

  const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false
  });

  app.use(globalLimiter);

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use('/webhook', webhookLimiter, webhookRoutes);
  app.use(
    express.json({
      limit: '2mb',
      verify: (req, res, buf) => {
        req.rawBody = buf;
      }
    })
  );
  app.use('/metrics', metricsRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/portal', portalRoutes);
  if (env.whatsappDebug && env.debugApiEnabled) {
    app.use('/debug', debugWhatsAppRoutes);
    app.use('/debug', debugRoutes);
    app.use('/debug', debugPhase2Routes);
    console.log('[DEBUG] Debug routes enabled');
  }
  app.use('/', authRoutes);

  function listRoutes(expressApp) {
    const routes = [];

    if (!expressApp || !expressApp._router || !Array.isArray(expressApp._router.stack)) {
      return routes;
    }

    expressApp._router.stack.forEach((middleware) => {
      if (middleware.route) {
        routes.push({
          method: Object.keys(middleware.route.methods)[0].toUpperCase(),
          path: middleware.route.path
        });
      } else if (middleware.name === 'router' && middleware.handle && Array.isArray(middleware.handle.stack)) {
        middleware.handle.stack.forEach((handler) => {
          if (handler.route) {
            const base = middleware.regexp
              ?.toString()
              ?.replace('/^\\', '')
              ?.replace('\\/?(?=\\/|$)/i', '')
              ?.replace(/\\\//g, '/')
              ?.replace(/\$$/, '');

            routes.push({
              method: Object.keys(handler.route.methods)[0].toUpperCase(),
              path: (base || '') + handler.route.path
            });
          }
        });
      }
    });

    return routes;
  }

  app.get('/routes-map', (req, res) => {
    const routes = listRoutes(app);
    res.json({
      success: true,
      count: routes.length,
      routes
    });
  });

  app.get('/__build', (req, res) => {
    res.status(200).json({
      ok: true,
      buildId: buildInfo.buildId,
      commitSha: buildInfo.commitSha,
      branchName: buildInfo.branchName,
      serviceName: buildInfo.serviceName,
      pid: process.pid,
      cwd: process.cwd(),
      file: __filename,
      argv0: process.argv[0] || null,
      argv1: process.argv[1] || null
    });
  });

  app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint not found' });
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  });

  return app;
}

module.exports = createApp;

