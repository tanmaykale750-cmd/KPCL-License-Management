// End-to-end demo journey through the real UI: Overview → Forecast → Options → What-if → Submit → Approvals → Review.
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:5173';
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => { errors.push('BROWSER DIALOG: ' + d.message()); d.dismiss(); });
  const shot = (n) => page.screenshot({ path: `scripts/screens/j-${n}.png` });
  const toast = async () => (await page.locator('.toast').last().innerText().catch(() => '')).replace(/\s+/g, ' ');
  const role = async (label) => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await page.locator('.user-menu').click();
    await page.getByRole('menuitemradio', { name: new RegExp(label) }).click();
    await page.waitForTimeout(500);
  };
  const step = (s) => console.log('✓', s);

  await page.goto(BASE + '/overview');
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE + '/overview');
  await page.waitForLoadState('networkidle');
  await role('Department Head');
  step('Department head on ' + new URL(page.url()).pathname);
  // Key Actions → forecast
  await page.locator('.panel-dark').getByText(/ANSYS/).first().click();
  await page.waitForTimeout(800);
  step('Key action opened ' + new URL(page.url()).pathname + new URL(page.url()).search);
  if (!page.url().includes('/planning')) await page.goto(BASE + '/planning?tab=forecast&licence=ANS-MECH');
  await page.waitForTimeout(600);
  await shot('1-forecast');
  await page.getByRole('button', { name: /Compare options/ }).click();
  await page.waitForTimeout(800);
  await shot('2-options');
  step('Options tab: ' + (await page.locator('table tbody tr').count()) + ' plans');
  await page.getByRole('button', { name: /Open in what-if/ }).click();
  await page.waitForTimeout(800);
  await page.getByLabel('Scenario name').fill('Combined plan for Project X');
  await shot('3-whatif');
  await page.getByRole('button', { name: /Submit for approval/ }).click();
  await page.waitForTimeout(600);
  step('Submit: ' + (await toast()));
  await shot('4-submitted');

  await role('Licence Administrator');
  await page.goto(BASE + '/registry?tab=approvals');
  await page.waitForTimeout(700);
  await shot('5-admin-queue');
  const recId = await page.evaluate(() => JSON.parse(localStorage.getItem('kpcl-eli-demo-state')).recommendations.find((r) => r.source === 'scenario').id);
  step('New recommendation ' + recId);
  await page.goto(BASE + `/registry?tab=approvals&open=${recId}`);
  await page.waitForTimeout(700);
  await shot('6-admin-drawer');
  await page.getByRole('button', { name: /Approve as/ }).click();
  await page.waitForTimeout(500);
  step('Admin decision: ' + (await toast()));

  // Tier-2 renewal recommendation needs admin then finance
  await page.goto(BASE + '/registry?tab=approvals&open=REC-1041');
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /Approve as/ }).click();
  await page.waitForTimeout(400);
  step('Admin on REC-1041: ' + (await toast()));
  await role('Leadership / Finance');
  await page.goto(BASE + '/registry?tab=approvals&open=REC-1041');
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /Approve as/ }).click();
  await page.waitForTimeout(400);
  step('Finance on REC-1041: ' + (await toast()));

  // Review: admin implements, finance verifies
  const rv = await page.evaluate(() => JSON.parse(localStorage.getItem('kpcl-eli-demo-state')).review.find((r) => r.recommendationId === 'REC-1041').id);
  await role('Licence Administrator');
  await page.goto(BASE + `/review?open=${rv}`);
  await page.waitForTimeout(600);
  await page.getByLabel('Purchase order').fill('PO-4500027781');
  await page.getByRole('button', { name: /Mark implemented/ }).click();
  await page.waitForTimeout(400);
  step('Implemented: ' + (await toast()));
  await role('Leadership / Finance');
  await page.goto(BASE + `/review?open=${rv}`);
  await page.waitForTimeout(600);
  await page.getByLabel('Invoice number').fill('INV-AD-2026-1290');
  await page.getByLabel('Unit price (₹)').fill('250000');
  await page.waitForTimeout(300);
  await shot('7-verify');
  await page.getByRole('button', { name: /Attach invoice and verify/ }).click();
  await page.waitForTimeout(500);
  step('Verified: ' + (await toast()));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await shot('8-review');
  const st = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('kpcl-eli-demo-state')); return { review: s.review.map((r) => `${r.id}:${r.state}`), audit: s.audit.length }; });
  step('Review states ' + st.review.join(', ') + ' · audit entries ' + st.audit);

  // Engineer cannot reach planning
  await role('Engineer');
  await page.goto(BASE + '/planning');
  await page.waitForTimeout(500);
  step('Engineer on /planning sees: ' + (await page.locator('.restricted, h1').first().innerText()).slice(0, 60));
  // Project leader limited to own project, no costs
  await role('Project Leader');
  await page.goto(BASE + '/planning?tab=whatif&licence=ANS-MECH');
  await page.waitForTimeout(700);
  await shot('9-projectlead-whatif');
  const rupees = await page.locator('main').innerText().then((t) => (t.match(/₹/g) || []).length);
  step('Project leader what-if: ₹ symbols on page = ' + rupees);

  if (errors.length) console.log('ERRORS:\n' + errors.join('\n'));
  else console.log('No console errors or browser dialogs.');
  await browser.close();
})().catch((e) => { console.error('JOURNEY FAILED', e.message); process.exit(1); });
