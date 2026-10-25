// Visit every route as every role at 1440×900; report console errors and save screenshots.
const { chromium } = require('playwright');
const ROUTES = ['/overview', '/registry', '/planning', '/planning?tab=supply', '/planning?tab=optimise', '/planning?tab=whatif', '/planning?tab=assistant', '/review', '/software', '/software?view=users', '/software?view=renewals', '/projects', '/access-requests', '/other-services', '/other-services?view=owners', '/vendors', '/reports', '/settings'];
const ROLES = ['admin', 'deptHead', 'finance', 'projectLead', 'engineer'];
(async () => {
  const browser = await chromium.launch();
  let errors = [];
  let total = 0;
  for (const role of ROLES) {
    // A fresh page per role keeps memory bounded across ~80 heavy navigations.
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto('http://127.0.0.1:5173/overview');
    await page.waitForLoadState('networkidle');
    await page.evaluate((r) => { const s = JSON.parse(localStorage.getItem('kpcl-eli-demo-state')); s.role = r; localStorage.setItem('kpcl-eli-demo-state', JSON.stringify(s)); }, role);
    const out = [];
    for (const r of ROUTES) {
      errors = [];
      await page.goto('http://127.0.0.1:5173' + r);
      await page.waitForTimeout(450);
      const restricted = await page.locator('.restricted').count();
      const hscroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      if (errors.length || hscroll) { total++; out.push(`${r}: ${errors.join(' | ').slice(0, 300)}${hscroll ? ' [horizontal scroll]' : ''}`); }
      else out.push(`${r}: ${restricted ? 'restricted' : 'ok'}`);
      if (role === 'admin' || role === 'deptHead') await page.screenshot({ path: `scripts/screens/sweep-${role}-${r.replace(/[/?=&]/g, '_')}.png` });
    }
    console.log(`\n${role}\n  ` + out.join('\n  '));
    await page.close();
  }
  console.log(`\nProblems: ${total}`);
  await browser.close();
})();
