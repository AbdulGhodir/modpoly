import {createBackendServer} from './app.js';
import {serverConfig} from './config.js';

const backend = createBackendServer();

backend.httpServer.listen(serverConfig.port, () => {
  console.info(`[http] Monopoly backend listening on port ${serverConfig.port}`);
  console.info(`[http] health check: http://localhost:${serverConfig.port}/health`);
});

function shutdown(signal) {
  console.info(`[http] received ${signal}; shutting down`);
  backend.io.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
