// astro.config.mjs
import { defineConfig } from 'astro/config';
import netlify from '@astrojs/netlify/functions';  // <-- switch to /functions
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://trek4free.com',
  output: 'hybrid',
  adapter: netlify(),   // keep as-is, no edge options
  integrations: [sitemap()],
});
