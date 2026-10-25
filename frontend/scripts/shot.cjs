// Screenshot helper for visual QA. Usage: node scripts/shot.cjs <path> <out.png> [role] [fullPage] [width] [height]
const { chromium } = require('playwright');
(async () => {
  const [, , path = '/overview', out = 'shot.png', role = 'admin', full = 'false', w = '1440', h = '900'] = process.argv;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://127.0.0.1:5173/overview');
  await page.waitForLoadState('networkidle');
  await page.evaluate((r) => {
    const raw = localStorage.getItem('kpcl-eli-demo-state');
    const s = raw ? JSON.parse(raw) : null;
    if (s) { s.role = r; localStorage.setItem('kpcl-eli-demo-state', JSON.stringify(s)); }
  }, role);
  await page.goto(`http://127.0.0.1:5173${path}`);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: out, fullPage: full === 'true' });
  if (errors.length) console.log('ERRORS:\n' + errors.join('\n'));
  await browser.close();
})();
