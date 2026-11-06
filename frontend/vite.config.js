import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Only /embed/* may be framed by other sites; every other page refuses framing (clickjacking).
// Production hosts must send the same headers; see README "Security headers".
function frameGuard(req, res, next) {
  if (!req.url.startsWith('/embed/')) {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

export default defineConfig({
  plugins: [react(), {
    name: 'frame-guard',
    configureServer(server) { server.middlewares.use(frameGuard); },
    configurePreviewServer(server) { server.middlewares.use(frameGuard); },
  }],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/widget.js': 'http://localhost:3000'
    }
  }
});
