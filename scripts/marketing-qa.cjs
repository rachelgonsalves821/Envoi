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
      const handoff = page.getByLabel('Interactive agent handoff demo', { exact: true });
      await handoff.getByRole('button', { name: 'Legal agent Dots' }).click();
      await handoff.getByRole('button', { name: 'Next step' }).click();
      await handoff.getByRole('button', { name: 'Next step' }).click();
      await handoff.getByRole('button', { name: 'Approve handoff' }).click();
      await handoff.getByText('Approved. The agents finished the handoff and saved a receipt.').waitFor();
      await handoff.screenshot({ path: path.join(output, `handoff-approved-${size.name}.png`) });
      // Reduced motion disables autonomous progression and moving beams.
      if (await handoff.locator('.handoff-beam.active').evaluate(el => getComputedStyle(el).animationName) !== 'none') throw new Error('Reduced motion ignored');
      await page.getByRole('link', { name: 'Explore the product' }).click();
      await page.getByRole('heading', { name: 'A shared inbox for agents' }).waitFor();
      await page.getByRole('link', { name: 'See how it works' }).click();
      if (!page.url().endsWith('#how-it-works')) throw new Error('Section navigation failed');
      if (await page.getByText('Join the waitlist', { exact: true }).count()) throw new Error('Product still contains waitlist CTA');
      const inbox = page.getByLabel('Interactive inbox demo', { exact: true });
      let demoWrites = 0;
      page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/api/')) demoWrites++; });
      await inbox.getByRole('button', { name: /Acme Q4 deck, market sizing slides/ }).click();
      const details = inbox.getByRole('region', { name: 'Case details' });
      await details.getByRole('button', { name: 'Approve', exact: true }).click();
      await details.getByText('Handoff complete', { exact: true }).waitFor();
      await details.getByRole('button', { name: 'Activity', exact: true }).click();
      await details.getByText('You approved the work. Handoff completed.', { exact: true }).waitFor();
      await inbox.screenshot({ path: path.join(output, `inbox-approved-${size.name}.png`) });
      await inbox.getByRole('navigation', { name: 'Inbox filters' }).getByRole('button', { name: /Needs you/ }).click();
      if (await inbox.locator('.case-row').count() !== 1) throw new Error('Approval did not update needs-you filter');
      await inbox.getByRole('button', { name: /Vendor contract, clause 7 redline/ }).click();
      await details.getByRole('button', { name: 'Request changes', exact: true }).click();
      await details.getByText('Work is in progress', { exact: true }).waitFor();
      await details.getByLabel('Add a note to this demo').fill('Please keep the renewal period at one year.');
      await details.getByRole('button', { name: 'Add note', exact: true }).click();
      await details.getByText('Please keep the renewal period at one year.', { exact: true }).waitFor();
      await inbox.getByRole('navigation', { name: 'Demo workspace' }).getByRole('button', { name: 'Files', exact: true }).click();
      await inbox.getByRole('button', { name: /Q1_hiring_plan.xlsx/ }).click();
      await details.getByText('Read only', { exact: true }).waitFor();
      await inbox.getByRole('navigation', { name: 'Demo workspace' }).getByRole('button', { name: 'Permissions', exact: true }).click();
      if (await inbox.locator('.permission-list>div').count() !== 4) throw new Error('Permissions missing');
      await inbox.getByRole('navigation', { name: 'Demo workspace' }).getByRole('button', { name: 'Activity', exact: true }).click();
      await inbox.getByRole('button', { name: 'Acme Q4 deck, market sizing slides', exact: true }).click();
      await details.getByText('You approved the work. Handoff completed.', { exact: true }).waitFor();
      await inbox.getByRole('navigation', { name: 'Inbox filters' }).getByRole('button', { name: /All inboxes/ }).click();
      await inbox.getByLabel('Search demo inbox').fill('nothing matches');
      await inbox.getByText('No matching cases', { exact: true }).waitFor();
      await inbox.getByLabel('Search demo inbox').fill('budget');
      if (await inbox.locator('.case-row').count() !== 1) throw new Error('Search failed');
      // Keyboard can open a case without a pointer.
      await inbox.locator('.case-row').focus();
      await page.keyboard.press('Enter');
      await details.getByRole('heading', { name: 'Hiring plan checked against Q1 budget' }).waitFor();
      await inbox.getByRole('button', { name: 'Reset demo' }).click();
      if (await inbox.locator('.case-row').count() !== 4) throw new Error('Reset did not restore cases');
      if (demoWrites) throw new Error('Demo made an API write');
      results.push({ size: size.name, interactions: 'handoff, approvals, changes, notes, filters, search, files, permissions, activity, keyboard, reset', demoWrites });
      await page.getByRole('link', { name: 'About', exact: true }).first().click();
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
    const motionContext = await browser.newContext({ viewport: { width: 820, height: 1180 }, reducedMotion: 'no-preference' });
    const motionPage = await motionContext.newPage();
    await motionPage.goto(base + '/about');
    const animated = motionPage.getByLabel('Interactive agent handoff demo', { exact: true });
    await animated.scrollIntoViewIfNeeded();
    await animated.getByRole('button', { name: 'Pause handoff animation' }).click();
    const pausedStep = await animated.locator('[aria-current=step]').textContent();
    await motionPage.waitForTimeout(3000);
    if (await animated.locator('[aria-current=step]').textContent() !== pausedStep) throw new Error('Pause did not stop progression');
    await animated.getByRole('button', { name: 'Play handoff animation' }).click();
    await animated.getByRole('button', { name: 'Approve handoff' }).waitFor({ timeout: 10000 });
    await motionPage.waitForTimeout(3000);
    if (!await animated.getByRole('button', { name: 'Approve handoff' }).isVisible()) throw new Error('Animation bypassed approval');
    await animated.getByRole('button', { name: 'Approve handoff' }).click();
    await animated.getByRole('button', { name: 'Replay handoff' }).click();
    await animated.getByRole('button', { name: 'Pause handoff animation' }).click();
    for (const width of [820, 320]) {
      await motionPage.setViewportSize({ width, height: 1000 });
      for (const route of ['/about', '/product']) {
        await motionPage.goto(base + route);
        await motionPage.locator('h1').waitFor();
        if (await motionPage.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Overflow at ${width} on ${route}`);
      }
    }
    results.push({ animation: 'autoplay, pause, resume, waits for approval, replay', additionalWidths: [820, 320] });
    await motionContext.close();
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ passed: true, output, results }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
