// Optional browser QA. Point MARKETING_PLAYWRIGHT_MODULE at an existing Playwright
// installation, or install Playwright separately from the application runtime.
const { chromium } = require(process.env.MARKETING_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const output = path.resolve(process.env.MARKETING_QA_OUTPUT || '.chrome-qa/marketing');
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.MARKETING_QA_BROWSER || 'chrome', headless: true });
  console.log('Browser launched');
  const results = [];
  const base = process.env.MARKETING_QA_URL || 'http://127.0.0.1:5173';
  try {
    for (const size of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      // Exercise the signed-out production entry without external identity calls.
      await page.route('**/api/auth/config', route => route.fulfill({ json: { provider: 'workos', hosted: true, signInPath: '/api/auth/workos/sign-in' } }));
      await page.route('**/api/auth/me', route => route.fulfill({ status: 401, json: { error: 'Not signed in' } }));
      for (const route of ['/', '/product']) {
        console.log('Rendering', size.name, route);
        await page.goto(base + route);
        await page.locator('h1').waitFor();
        for (const image of await page.locator('img[loading="lazy"]').all()) await image.scrollIntoViewIfNeeded();
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.evaluate(async () => { await Promise.race([Promise.all([document.fonts.ready, ...Array.from(document.images, img => img.decode().catch(() => {}))]), new Promise(resolve => setTimeout(resolve, 5000))]); });
        const check = await page.evaluate(() => ({
          title: document.title,
          heading: document.querySelector('h1')?.textContent,
          overflow: document.documentElement.scrollWidth > innerWidth,
          nav: [...document.querySelectorAll('nav .links a')].map(el => el.textContent),
          footer: [...document.querySelectorAll('.footer-nav a')].map(el => el.textContent),
          images: [...document.querySelectorAll('img')].map(img => ({ alt: img.alt, loaded: img.complete && img.naturalWidth > 0 })),
          benefits: document.querySelectorAll('.diagram-point').length,
          features: document.querySelectorAll('.feature-card').length,
          forbidden: /Your work in one place|Where we are now|advisors|—/.test(document.querySelector('main').innerText),
          eyebrows: document.querySelectorAll('main .eyebrow').length
        }));
        if (check.overflow || check.forbidden || check.eyebrows || check.images.some(img => !img.loaded)) throw new Error(JSON.stringify(check));
        await page.screenshot({ path: path.join(output, `${route === '/' ? 'about' : 'product'}-${size.name}.png`), fullPage: true });
        results.push({ size: size.name, route, ...check });
      }
      await page.getByRole('link', { name: 'About', exact: true }).first().click();
      await page.getByRole('heading', { name: 'Good work has always been a team effort' }).waitFor();
      await page.getByRole('link', { name: 'Explore the product' }).click();
      await page.getByRole('heading', { name: 'A shared inbox for agents' }).waitFor();
      await page.getByRole('link', { name: 'See how it works' }).click();
      if (!page.url().endsWith('#how-it-works')) throw new Error('Section navigation failed');
      const trigger = page.getByRole('button', { name: 'Join the waitlist' }).first();
      await trigger.click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      if (!await trigger.evaluate(el => el === document.activeElement)) throw new Error('Dialog did not restore focus');
      await trigger.click();
      await dialog.getByLabel('Email address').fill('preview@example.com');
      let calls = 0;
      await page.route('**/api/waitlist', route => { calls++; return route.fulfill({ status: calls === 1 ? 503 : 200, json: calls === 1 ? { error: 'Try again' } : { accepted: true } }); });
      await dialog.getByRole('button', { name: 'Join the waitlist' }).click();
      await dialog.getByRole('alert').waitFor();
      await dialog.getByRole('button', { name: 'Join the waitlist' }).click();
      await dialog.getByRole('status').waitFor();
      if (calls !== 2) throw new Error('Waitlist retry failed');
      await page.screenshot({ path: path.join(output, `waitlist-${size.name}.png`) });
      await dialog.getByRole('button', { name: 'Done' }).click();
      if (errors.length) throw new Error(errors.join('\n'));
      await context.close();
    }
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ passed: true, output, results }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
