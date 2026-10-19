import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { emptySentBudgetAlerts, type SentBudgetAlerts } from '../notify/budgetAlerts'
import { BudgetAlertStore } from './budgetAlerts'

let file: string

beforeEach(async () => {
  file = join(await mkdtemp(join(tmpdir(), 'mm-budget-')), 'nested', 'budget-alerts.json')
})

const sent: SentBudgetAlerts = {
  version: 1,
  daily: { day: '2026-10-19', limit: 10, level: 'warn' },
  tasks: { k1: { limit: 5, level: 'over' } },
}

describe('BudgetAlertStore', () => {
  it('gives an empty record when there is no file', async () => {
    await expect(new BudgetAlertStore(file).load()).resolves.toEqual(emptySentBudgetAlerts())
  })

  it('round-trips what was sent', async () => {
    await new BudgetAlertStore(file).save(sent)
    await expect(new BudgetAlertStore(file).load()).resolves.toEqual(sent)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(sent)
  })

  it('drops invalid entries, and gives an empty record for a corrupt file without a usable backup', async () => {
    const store = new BudgetAlertStore(file)
    await store.save(sent)
    await writeFile(file, JSON.stringify({ ...sent, tasks: { k1: { limit: 'x', level: 'over' } } }), 'utf8')
    await expect(store.load()).resolves.toEqual({ ...sent, tasks: {} })
    await writeFile(file, '{ nope', 'utf8')
    await writeFile(file + '.bak', 'garbage', 'utf8')
    await expect(new BudgetAlertStore(file).load()).resolves.toEqual(emptySentBudgetAlerts())
  })

  it('saves one at a time', async () => {
    const store = new BudgetAlertStore(file)
    const later = { ...sent, tasks: {} }
    await Promise.all([store.save(sent), store.save(later)])
    await expect(store.load()).resolves.toEqual(later)
  })
})
