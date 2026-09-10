import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { once } from 'node:events'
import { chromium } from 'playwright'

const port = Number(process.env.DASHBOARD_SMOKE_PORT || 5176)
const cwd = new URL('..', import.meta.url)
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const server = spawn(npmCmd, ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd,
  env: { ...process.env, BROWSER: 'none' },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
})

let output = ''
server.stdout.on('data', chunk => { output += chunk.toString() })
server.stderr.on('data', chunk => { output += chunk.toString() })

try {
  await waitForServer(server, () => output.includes(`127.0.0.1:${port}`) || output.includes(`localhost:${port}`))
  const executablePath = findChromiumExecutable()
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  await page.addInitScript(() => localStorage.setItem('vsm_auth_token', 'smoke-token'))
  await page.route('**/api/auth/me', route => json(route, { user: { username: 'smoke', role: 'admin' } }))
  await page.route('**/api/wip/tv-dashboard/metrics**', route => json(route, makeDashboardData()))
  await page.route('**/api/wip/analytics/daily-summary**', route => json(route, makeDailySummary()))

  await page.goto(`http://127.0.0.1:${port}/dashboard`, { waitUntil: 'networkidle' })
  await page.waitForSelector('text=Гонка участков ВСМ', { timeout: 10_000 })
  assert.equal(await page.locator('.dash-section-card').count(), 8)
  await page.getByRole('button', { name: /Песок/ }).click()
  await page.waitForSelector('text=Песок: доставлено', { timeout: 5_000 })
  await page.getByRole('button', { name: /АД/ }).click()
  await page.waitForSelector('text=Темп временных АД', { timeout: 5_000 })
  await browser.close()
  console.log('dashboard smoke test passed')
} finally {
  stopServer(server)
  await Promise.race([once(server, 'exit'), new Promise(resolve => setTimeout(resolve, 1500))])
}

function stopServer(child) {
  if (child.pid == null) return
  try {
    if (process.platform === 'win32') child.kill('SIGTERM')
    else process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

function findChromiumExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    '/opt/vsm/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell',
    '/opt/vsm/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome',
  ].filter(Boolean)
  return candidates.find(path => {
    try { return existsSync(path) } catch { return false }
  })
}

function json(route, data) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
}

async function waitForServer(child, ready) {
  const started = Date.now()
  while (!ready()) {
    if (child.exitCode != null) throw new Error(`dev server exited early:\n${output}`)
    if (Date.now() - started > 20_000) throw new Error(`dev server timeout:\n${output}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

function makeDashboardData() {
  const sections = Array.from({ length: 8 }, (_, idx) => ({ code: `UCH_${idx + 1}`, name: `Участок №${idx + 1}` }))
  return {
    from: '2026-05-13',
    to: '2026-05-19',
    sections,
    sand: {
      total_volume: 36000,
      by_section: sections.map((section, idx) => ({
        section_code: section.code,
        section_name: section.name,
        volume: 6200 - idx * 420,
        placed_volume: 5200 - idx * 350,
        stockpile_volume: 800 + idx * 20,
        trips: 110 - idx * 6,
        ton_km: 14000 - idx * 900,
        missing_distance_rows: idx === 7 ? 1 : 0,
      })),
    },
    equipment: {
      units_total: 74,
      by_section: sections.map((section, idx) => ({
        section_code: section.code,
        section_name: section.name,
        units_count: 12 - Math.floor(idx / 2),
        shifts: 34 - idx,
        avg_percent: 96 - idx * 4,
        dump_truck_shifts: 18 - idx,
        pile_drivers: idx < 5 ? 2 : 1,
      })),
    },
    piles: {
      drivers: sections.slice(0, 4).map((section, idx) => ({
        equipment_type: 'сваебойная установка',
        brand_model: `Junttan PMx${idx + 1}`,
        plate_number: `ТЕСТ-${idx + 1}`,
        unit_number: `PD-${idx + 1}`,
        status: 'work',
        location: 'свайное поле',
        section_code: section.code,
        source_date: '2026-05-19',
      })),
      by_section: sections.map((section, idx) => ({
        section_code: section.code,
        section_name: section.name,
        fact_total: 82 - idx * 7,
        plan_total: 90,
        percent: (82 - idx * 7) / 90 * 100,
        pile_drivers: idx < 5 ? 2 : 1,
        piles_per_driver: idx < 5 ? 41 - idx * 3 : 30 - idx,
      })),
    },
  }
}

function makeDailySummary() {
  const sections = Array.from({ length: 8 }, (_, idx) => ({
    section: idx + 1,
    length_m: 4200 + idx * 180,
    ready_plus_done_m: 3100 - idx * 170,
    pct_ready_plus_done: Math.max(12, 74 - idx * 7),
    required_rate_m_per_day: 70 + idx * 12,
  }))
  return {
    from: '2026-05-13',
    to: '2026-05-19',
    summary: {
      prs_m3: 1200,
      vyemka_m3: 820,
      shpgs_m3: 2100,
      sand_transport: { own: 12000, almaz: 9000, hired: 6000, total: 27000 },
      sand_quarry_transport: { own: 13000, almaz: 10000, hired: 7000, total: 30000 },
      shpgs_transport: { own: 1000, almaz: 800, hired: 300, total: 2100 },
      soil_transport: { own: 420, almaz: 200, hired: 180, total: 800 },
      piles: { main: 390, trial: 30, dyntest: 11, total: 420 },
    },
    stage3: {
      total_length_m: sections.reduce((sum, row) => sum + row.length_m, 0),
      passable_m: 22500,
      completed_m: 12400,
      ready_plus_done_m: sections.reduce((sum, row) => sum + row.ready_plus_done_m, 0),
      required_rate_m_per_day_total: 870,
      target_date: '2026-05-15',
      days_to_target: 1,
      sections,
    },
  }
}
