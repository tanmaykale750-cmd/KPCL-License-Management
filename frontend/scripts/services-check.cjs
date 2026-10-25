// Interaction checks for Module 5 — Other Services, through the real UI.
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:5173';
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => { errors.push('DIALOG ' + d.message()); d.dismiss(); });
  const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) process.exitCode = 1; };
  const rows = () => page.locator('#svc-inventory ~ section').first().locator('tbody tr').count();
  const role = async (r) => { await page.evaluate((r) => { const s = JSON.parse(localStorage.getItem('kpcl-eli-demo-state')); s.role = r; localStorage.setItem('kpcl-eli-demo-state', JSON.stringify(s)); }, r); };

  await page.goto(BASE + '/overview');
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE + '/overview');
  await page.waitForLoadState('networkidle');

  // Navigation from the sidebar
  await page.getByRole('link', { name: 'Other Services' }).click();
  await page.waitForTimeout(800);
  ok(page.url().endsWith('/other-services'), 'Sidebar link opens /other-services');
  ok(await page.locator('.nav-item.active', { hasText: 'Other Services' }).count() === 1, 'Nav item shows selected state');
  ok((await page.locator('.kpi').count()) === 5, 'Five KPI cards');
  const all = await rows();
  ok(all === 26, `Inventory shows all services (${all})`);

  // Filters
  await page.getByLabel('Service category').selectOption('ai');
  await page.waitForTimeout(300);
  ok((await rows()) === 5, `Category filter → AI tokens (${await rows()} rows)`);
  await page.getByLabel('Billing type').selectOption('payg');
  await page.waitForTimeout(300);
  ok((await rows()) === 3, `Billing filter → pay-as-you-go (${await rows()} rows)`);
  const idleKpi = await page.locator('.kpi', { hasText: 'Idle Spend' }).locator('.kpi-value').innerText();
  ok(idleKpi.trim() === '₹0', `Pay-as-you-go AI tokens have no idle spend (${idleKpi.trim()})`);
  await page.getByLabel('Service category').selectOption('all');
  await page.getByLabel('Billing type').selectOption('all');
  await page.getByLabel('Department').selectOption('unallocated');
  await page.waitForTimeout(300);
  ok((await rows()) === 3, `Department filter → Unallocated (${await rows()} rows)`);
  await page.getByLabel('Department').selectOption('all');
  await page.getByLabel('Period').selectOption('3');
  await page.waitForTimeout(300);
  ok((await page.locator('th', { hasText: 'Spend (3 m)' }).count()) === 1, 'Period filter relabels the table');
  await page.getByLabel('Period').selectOption('12');

  // Search, row click → drawer with masked keys only
  await page.getByLabel(/Search services, providers/).fill('claude');
  await page.waitForTimeout(300);
  ok((await rows()) === 1, 'Search narrows to one service');
  await page.locator('#svc-inventory ~ section').first().locator('tbody tr').first().click();
  await page.waitForTimeout(500);
  ok(page.url().includes('open=SV-AI-02'), 'Row click opens the service drawer');
  const drawer = await page.locator('.drawer').innerText();
  ok(/sk-ant-••••[A-Za-z0-9]{4}/.test(drawer), 'Drawer shows masked key with last four characters');
  ok(/how idle spend is judged/i.test(drawer), 'Drawer explains the idle rule');
  await page.screenshot({ path: 'scripts/screens/svc-drawer.png' });
  await page.keyboard.press('Escape');
  await page.getByLabel(/Search services, providers/).fill('');

  // Owner view and export
  await page.getByRole('tab', { name: 'Owner view' }).click().catch(async () => page.getByText('Owner view').click());
  await page.waitForTimeout(400);
  ok(page.url().includes('view=owners'), 'Owner view tab');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export/ }).click()]);
  const p = await dl.path();
  const txt = require('fs').readFileSync(p, 'utf8');
  ok(dl.suggestedFilename() === 'other-services-owners-sample.csv' && txt.includes('SAMPLE DATA'), `Export downloads ${dl.suggestedFilename()} labelled as sample data`);
  await page.getByRole('tab', { name: 'Service / Key view' }).click();
  await page.waitForTimeout(300);
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export/ }).click()]);
  const t2 = require('fs').readFileSync(await dl2.path(), 'utf8');
  ok(!/sk-ant-[A-Za-z0-9]{10,}/.test(t2) && t2.includes('••••'), 'Inventory export contains only masked keys');

  // Bar click filters by department; summary row scrolls to a section
  await page.locator('.recharts-bar-rectangle').first().click({ force: true });
  await page.waitForTimeout(400);
  const dept = await page.getByLabel('Department').inputValue();
  ok(dept !== 'all', `Clicking a department bar filters the page (${dept})`);
  await page.getByLabel('Department').selectOption('all');
  await page.getByRole('button', { name: /rarely used/ }).click();
  await page.waitForTimeout(700);
  ok(await page.locator('#svc-keys').isVisible(), 'Summary row scrolls to the rarely-used keys section');

  // Department head: locked to own department
  await role('deptHead');
  await page.goto(BASE + '/other-services');
  await page.waitForTimeout(800);
  ok(await page.getByLabel('Department').isDisabled(), 'Department head: department filter locked');
  const dh = await page.locator('#svc-inventory ~ section').first().locator('tbody tr').count();
  ok(dh === 4, `Department head sees only Simulation services (${dh})`);
  await page.screenshot({ path: 'scripts/screens/svc-depthead.png' });

  // Finance: company-wide summary, owner names hidden
  await role('finance');
  await page.goto(BASE + '/other-services');
  await page.waitForTimeout(800);
  ok((await page.locator('#svc-inventory ~ section').first().locator('tbody tr').count()) === 26, 'Finance sees company-wide services');
  ok((await page.locator('th', { hasText: /^Owner/ }).count()) === 0, 'Finance: owner column hidden');
  ok((await page.getByText('Owner view').count()) === 0, 'Finance: owner view hidden');

  // Project leader and engineer: no access, no nav entry
  for (const r of ['projectLead', 'engineer']) {
    await role(r);
    await page.goto(BASE + '/other-services');
    await page.waitForTimeout(600);
    ok((await page.locator('.restricted').count()) === 1 && (await page.getByRole('link', { name: 'Other Services' }).count()) === 0, `${r}: restricted and not in the sidebar`);
  }

  ok(errors.length === 0, errors.length ? 'Errors: ' + errors.join(' | ') : 'No console errors or browser dialogs');
  await browser.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
