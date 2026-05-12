import fs from 'fs';
import { fileURLToPath } from 'url';

// ─────────────────────────────────────────────────────────────────────────────
// DOM setup
// ─────────────────────────────────────────────────────────────────────────────
export function loadHtml(htmlFile) {

  const htmlPath = fileURLToPath(
      new URL(htmlFile, import.meta.url)
  );
  document.body.innerHTML = fs.readFileSync(htmlPath, 'utf8');
}
