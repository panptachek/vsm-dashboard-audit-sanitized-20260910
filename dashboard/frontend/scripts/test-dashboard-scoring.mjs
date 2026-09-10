import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const sourceUrl = new URL('../src/pages-wip-v2/dashboardScoring.ts', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
const scoring = await import(moduleUrl)

assert.equal(scoring.normalizeToBest(75, 100), 75)
assert.equal(scoring.normalizeToBest(200, 100), 150)
assert.equal(scoring.normalizeToBest(10, 0), 0)
assert.equal(scoring.clampScore(-5), 0)
assert.equal(scoring.clampScore(175), 150)

const score = scoring.calculateDashboardScore({
  sandDelivered: 100,
  sandPlaced: 50,
  pilesDriven: 80,
  accessRoadEmbankmentRate: 40,
  equipmentUptime: 75,
  dataQualityPenalty: 5,
})
assert.equal(score.score, 64.6)
assert.equal(score.penalty, 5)
assert.equal(score.contributions.sandDelivered, 24)
assert.equal(score.contributions.sandPlaced, 12)
assert.equal(score.components.equipmentUptime, 75)

assert.equal(scoring.formatCompact(999), '999')
assert.equal(scoring.formatCompact(12_500), '13k')
assert.equal(scoring.formatIsoDate('2026-05-20'), '20.05.2026')

console.log('dashboard scoring tests passed')
