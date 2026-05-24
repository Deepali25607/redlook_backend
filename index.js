// Thin entrypoint. The actual server lives in src/index.js so the layout
// matches the FreshKart sibling project. `node .` or `npm start` (after
// prisma migrate deploy) routes through here; `npm run dev` calls
// src/index.js directly.
import './src/index.js';
