import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXBhYmFzZSIsImlhdCI6MTc3ODU5NjgwMCwiZXhwIjo0OTM0MjcwNDAwLCJyb2xlIjoic2VydmljZV9yb2xlIn0.-kHn8BvrGRULXFVYvT1t7L_9kE99KFmkiuseRaBUbg0';

const sqlPath = join(__dirname, '..', 'migrations', '0013_template_clinicorp_dental.sql');
const sql = readFileSync(sqlPath, 'utf8');

const idx1 = sql.indexOf('$PROMPT$');
const idx2 = sql.lastIndexOf('$PROMPT$');
if (idx1 === idx2) { console.error('PROMPT delimiters not found'); process.exit(1); }
const systemPrompt = sql.slice(idx1 + 8, idx2).trim();
console.log(`Prompt extraído: ${systemPrompt.length} chars`);

const body = JSON.stringify({ system_prompt: systemPrompt });

const opts = {
  hostname: 'db.72.62.104.184.sslip.io',
  path: '/rest/v1/prompt_templates?id=eq.9cde4bcb-40fe-4dd5-81ac-dfb27d7a4e57',
  method: 'PATCH',
  headers: {
    'apikey': TOKEN,
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal',
    'Content-Length': Buffer.byteLength(body),
  },
  rejectUnauthorized: false,
};

const r = https.request(opts, (res) => {
  let d = '';
  res.on('data', (c) => d += c);
  res.on('end', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      console.log(`✅ System prompt atualizado! HTTP ${res.statusCode}`);
    } else {
      console.error(`HTTP ${res.statusCode}: ${d.slice(0, 300)}`);
    }
  });
});
r.on('error', (e) => console.error('ERR:', e.message));
r.write(body);
r.end();
