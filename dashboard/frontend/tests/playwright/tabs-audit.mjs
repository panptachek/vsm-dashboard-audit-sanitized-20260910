#!/usr/bin/env node
/**
 * VSM Dashboard QA Audit Script
 * Visits all routes, takes screenshots, checks for errors and white screens.
 * Runs with: node tests/playwright/tabs-audit.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';

const BASE = 'http://localhost:5173';
const AUDIT_DIR = '/tmp/vsm-tabs-audit';
const FINAL_DIR = '/tmp/vsm-final';
const REPORT_PATH = '/tmp/vsm-white-screens.md';

// All routes to test
const ROUTES = [
  { path: '/', name: 'analytics' },
  { path: '/overview', name: 'overview' },
  { path: '/map', name: 'map' },
  { path: '/daily-quarry-report', name: 'daily-quarry-report' },
  { path: '/sections/UCH_1', name: 'section-UCH_1' },
  { path: '/sections/UCH_2', name: 'section-UCH_2' },
  { path: '/sections/UCH_3', name: 'section-UCH_3' },
  { path: '/sections/UCH_4', name: 'section-UCH_4' },
  { path: '/sections/UCH_5', name: 'section-UCH_5' },
  { path: '/sections/UCH_6', name: 'section-UCH_6' },
  { path: '/sections/UCH_7', name: 'section-UCH_7' },
  { path: '/sections/UCH_8', name: 'section-UCH_8' },
  { path: '/sections/UCH_31', name: 'section-UCH_31' },
  { path: '/sections/UCH_32', name: 'section-UCH_32' },
  { path: '/reports', name: 'reports' },
];

mkdirSync(AUDIT_DIR, { recursive: true });
mkdirSync(FINAL_DIR, { recursive: true });

async function isWhiteScreen(page) {
  const result = await page.evaluate(() => {
    const body = document.body;
    const text = body.innerText.trim();
    const children = body.querySelectorAll('*').length;
    return { textLength: text.length, elementCount: children, bodyText: text.slice(0, 200) };
  });
  return {
    isWhite: result.textLength < 10 && result.elementCount < 15,
    textLength: result.textLength,
    elementCount: result.elementCount,
    bodyText: result.bodyText,
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });

  const results = [];
  const allErrors = [];

  console.log('=== VSM Dashboard QA Audit ===\n');

  // -- PHASE 1: Visit all routes --
  console.log('--- Phase 1: Route audit ---');
  for (const route of ROUTES) {
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];

    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    const url = `${BASE}${route.path}`;
    console.log(`  Visiting ${route.path} ...`);

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    } catch (e) {
      console.log(`    WARN: navigation timeout/error for ${route.path}: ${e.message}`);
    }

    // Extra wait for dynamic content
    await page.waitForTimeout(1500);

    // Check white screen
    const whiteCheck = await isWhiteScreen(page);

    // Take screenshot
    const screenshotPath = `${AUDIT_DIR}/${route.name}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`    Screenshot: ${screenshotPath} | text=${whiteCheck.textLength} els=${whiteCheck.elementCount} white=${whiteCheck.isWhite}`);

    const entry = {
      route: route.path,
      name: route.name,
      pageErrors,
      consoleErrors,
      isWhite: whiteCheck.isWhite,
      textLength: whiteCheck.textLength,
      elementCount: whiteCheck.elementCount,
      bodyText: whiteCheck.bodyText,
      screenshot: screenshotPath,
    };
    results.push(entry);

    if (pageErrors.length > 0 || consoleErrors.length > 0) {
      allErrors.push(entry);
    }

    await page.close();
  }

  // -- PHASE 2: Sidebar navigation clicks --
  console.log('\n--- Phase 2: Sidebar navigation ---');
  const navPage = await context.newPage();
  const navErrors = [];
  navPage.on('pageerror', (err) => navErrors.push(err.message));
  navPage.on('console', (msg) => {
    if (msg.type() === 'error') navErrors.push(`CONSOLE: ${msg.text()}`);
  });

  await navPage.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 });
  await navPage.waitForTimeout(1000);

  const sidebarLinks = await navPage.$$('aside nav a');
  console.log(`  Found ${sidebarLinks.length} sidebar links`);

  for (let i = 0; i < sidebarLinks.length; i++) {
    const links = await navPage.$$('aside nav a');
    if (i >= links.length) break;
    const link = links[i];
    const label = await link.innerText();
    const href = await link.getAttribute('href');
    console.log(`  Clicking sidebar: "${label}" (${href})`);
    await link.click();
    try {
      await navPage.waitForLoadState('networkidle', { timeout: 10000 });
    } catch (_) { /* timeout ok */ }
    await navPage.waitForTimeout(1000);
    await navPage.screenshot({
      path: `${AUDIT_DIR}/sidebar-click-${i}-${label.replace(/\s+/g, '_')}.png`,
      fullPage: true,
    });
  }

  if (navErrors.length > 0) {
    console.log(`  Sidebar nav errors: ${navErrors.join('; ')}`);
  }
  await navPage.close();

  // -- PHASE 3: Analytics section filter test --
  console.log('\n--- Phase 3: Analytics section filter ---');
  const analyticsPage = await context.newPage();
  const analyticsErrors = [];
  analyticsPage.on('pageerror', (err) => analyticsErrors.push(err.message));
  analyticsPage.on('console', (msg) => {
    if (msg.type() === 'error') analyticsErrors.push(`CONSOLE: ${msg.text()}`);
  });

  await analyticsPage.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 });
  await analyticsPage.waitForTimeout(1500);

  await analyticsPage.screenshot({
    path: `${AUDIT_DIR}/analytics-before-filter.png`,
    fullPage: true,
  });

  // Click section 6 button
  const sec6Buttons = await analyticsPage.$$('button');
  let sec6Clicked = false;
  for (const btn of sec6Buttons) {
    const text = await btn.innerText();
    if (text.trim() === '6') {
      console.log('  Clicking section 6 filter button');
      await btn.click();
      sec6Clicked = true;
      break;
    }
  }

  if (sec6Clicked) {
    try {
      await analyticsPage.waitForLoadState('networkidle', { timeout: 10000 });
    } catch (_) {}
    await analyticsPage.waitForTimeout(2000);

    const currentUrl = analyticsPage.url();
    const hasFilter = currentUrl.includes('sections=6');
    console.log(`  URL after click: ${currentUrl}`);
    console.log(`  Filter applied in URL: ${hasFilter}`);

    await analyticsPage.screenshot({
      path: `${AUDIT_DIR}/analytics-section6-filtered.png`,
      fullPage: true,
    });
  } else {
    console.log('  WARNING: Could not find section 6 button');
  }

  if (analyticsErrors.length > 0) {
    console.log(`  Analytics errors: ${analyticsErrors.join('; ')}`);
  }
  await analyticsPage.close();

  // -- PHASE 4: Map object type filter test --
  console.log('\n--- Phase 4: Map object type filter ---');
  const mapPage = await context.newPage();
  const mapErrors = [];
  mapPage.on('pageerror', (err) => mapErrors.push(err.message));
  mapPage.on('console', (msg) => {
    if (msg.type() === 'error') mapErrors.push(`CONSOLE: ${msg.text()}`);
  });

  await mapPage.goto(`${BASE}/map`, { waitUntil: 'networkidle', timeout: 15000 });
  await mapPage.waitForTimeout(3000);

  await mapPage.screenshot({
    path: `${AUDIT_DIR}/map-before-filter.png`,
    fullPage: true,
  });

  // Look for filter checkboxes/buttons
  const mapCheckboxes = await mapPage.$$('input[type="checkbox"]');
  const mapButtons = await mapPage.$$('button');
  console.log(`  Found ${mapCheckboxes.length} checkboxes and ${mapButtons.length} buttons on map page`);

  const objectTypeLabels = ['Трубы', 'Мосты', 'Путепроводы', 'Свайные', 'Пересечения', 'pipe', 'bridge', 'overpass'];
  let filterClicked = false;

  for (const cb of mapCheckboxes) {
    const parent = await cb.evaluateHandle(el => el.closest('label') || el.parentElement);
    const parentText = await parent.evaluate(el => el?.textContent || '');
    for (const label of objectTypeLabels) {
      if (parentText.toLowerCase().includes(label.toLowerCase())) {
        console.log(`  Clicking map filter checkbox: "${parentText.trim().slice(0, 40)}"`);
        await cb.click();
        filterClicked = true;
        break;
      }
    }
    if (filterClicked) break;
  }

  if (!filterClicked) {
    for (const btn of mapButtons) {
      const text = await btn.innerText();
      for (const label of objectTypeLabels) {
        if (text.toLowerCase().includes(label.toLowerCase())) {
          console.log(`  Clicking map filter button: "${text.trim().slice(0, 40)}"`);
          await btn.click();
          filterClicked = true;
          break;
        }
      }
      if (filterClicked) break;
    }
  }

  if (filterClicked) {
    await mapPage.waitForTimeout(1500);
    await mapPage.screenshot({
      path: `${AUDIT_DIR}/map-after-filter.png`,
      fullPage: true,
    });
  } else {
    console.log('  WARNING: Could not find map object type filter controls');
    const allText = await mapPage.evaluate(() => document.body.innerText);
    const filterRelated = allText.split('\n').filter(l =>
      /труб|мост|путепровод|свай|пересеч|фильтр|объект/i.test(l)
    );
    if (filterRelated.length > 0) {
      console.log('  Filter-related text found on page:');
      filterRelated.slice(0, 5).forEach(l => console.log(`    "${l.trim()}"`));
    }
  }

  if (mapErrors.length > 0) {
    console.log(`  Map page errors: ${mapErrors.join('; ')}`);
  }
  await mapPage.close();

  // -- PHASE 5: Final screenshots --
  console.log('\n--- Phase 5: Final screenshots ---');
  for (const route of ROUTES) {
    const page = await context.newPage();
    page.on('pageerror', () => {});
    page.on('console', () => {});

    try {
      await page.goto(`${BASE}${route.path}`, { waitUntil: 'networkidle', timeout: 15000 });
    } catch (_) {}
    await page.waitForTimeout(1500);

    const finalPath = `${FINAL_DIR}/${route.name}.png`;
    await page.screenshot({ path: finalPath, fullPage: true });
    console.log(`  ${finalPath}`);
    await page.close();
  }

  // -- PHASE 6: Generate report --
  console.log('\n--- Phase 6: Generating report ---');

  const whiteScreens = results.filter(r => r.isWhite);
  const errorRoutes = results.filter(r => r.pageErrors.length > 0 || r.consoleErrors.length > 0);

  let report = `# VSM Dashboard White Screen / Error Audit\n\n`;
  report += `**Date:** ${new Date().toISOString()}\n`;
  report += `**Routes tested:** ${results.length}\n\n`;

  if (whiteScreens.length === 0 && errorRoutes.length === 0) {
    report += `## Result: All clear\n\nNo white screens or console errors detected on any route.\n\n`;
  }

  if (whiteScreens.length > 0) {
    report += `## White Screens Detected\n\n`;
    for (const ws of whiteScreens) {
      report += `### ${ws.route}\n`;
      report += `- **Text length:** ${ws.textLength} chars\n`;
      report += `- **Element count:** ${ws.elementCount}\n`;
      report += `- **Body preview:** \`${ws.bodyText}\`\n`;
      report += `- **Page errors:** ${ws.pageErrors.length > 0 ? ws.pageErrors.join('; ') : 'none'}\n`;
      report += `- **Console errors:** ${ws.consoleErrors.length > 0 ? ws.consoleErrors.join('; ') : 'none'}\n`;

      let cause = 'Unknown';
      if (ws.pageErrors.some(e => /Cannot read.*undefined|null/i.test(e))) {
        cause = 'JS runtime error - accessing property on null/undefined';
      } else if (ws.pageErrors.some(e => /fetch|network|Failed/i.test(e))) {
        cause = 'API fetch failure - backend may be down or endpoint missing';
      } else if (ws.consoleErrors.some(e => /404|Not Found/i.test(e))) {
        cause = 'Missing resource or API endpoint (404)';
      } else if (ws.textLength === 0 && ws.elementCount < 5) {
        cause = 'Component not rendering - possible import error or missing route handler';
      }
      report += `- **Probable cause:** ${cause}\n`;
      report += `- **Screenshot:** ${ws.screenshot}\n\n`;
    }
  } else {
    report += `## White Screens\n\nNone detected.\n\n`;
  }

  if (errorRoutes.length > 0) {
    report += `## Routes with Console/Page Errors\n\n`;
    for (const er of errorRoutes) {
      report += `### ${er.route}\n`;
      if (er.pageErrors.length > 0) {
        report += `- **Page errors:**\n`;
        er.pageErrors.forEach(e => { report += `  - \`${e}\`\n`; });
      }
      if (er.consoleErrors.length > 0) {
        report += `- **Console errors:**\n`;
        er.consoleErrors.forEach(e => { report += `  - \`${e}\`\n`; });
      }
      report += `- **Screenshot:** ${er.screenshot}\n\n`;
    }
  } else {
    report += `## Console/Page Errors\n\nNone detected.\n\n`;
  }

  report += `## Route Summary\n\n`;
  report += `| Route | White? | Text Len | Elements | Page Errors | Console Errors |\n`;
  report += `|-------|--------|----------|----------|-------------|----------------|\n`;
  for (const r of results) {
    report += `| ${r.route} | ${r.isWhite ? 'YES' : 'no'} | ${r.textLength} | ${r.elementCount} | ${r.pageErrors.length} | ${r.consoleErrors.length} |\n`;
  }

  report += `\n## Screenshots\n\n`;
  report += `- Audit: \`${AUDIT_DIR}/\`\n`;
  report += `- Final: \`${FINAL_DIR}/\`\n`;

  writeFileSync(REPORT_PATH, report);
  console.log(`\nReport written to ${REPORT_PATH}`);

  // Print summary
  console.log('\n=== SUMMARY ===');
  console.log(`Routes tested: ${results.length}`);
  console.log(`White screens: ${whiteScreens.length}`);
  console.log(`Routes with errors: ${errorRoutes.length}`);
  if (whiteScreens.length > 0) {
    console.log('White screen routes:');
    whiteScreens.forEach(ws => console.log(`  - ${ws.route}`));
  }
  if (errorRoutes.length > 0) {
    console.log('Error routes:');
    errorRoutes.forEach(er => {
      console.log(`  - ${er.route}: ${[...er.pageErrors, ...er.consoleErrors].slice(0, 2).join('; ')}`);
    });
  }

  await browser.close();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
