import { emptySentBudgetAlerts, normalizeSentBudgetAlerts, type SentBudgetAlerts } from '../notify/budgetAlerts'
import { JsonFile } from './jsonFile'

export interface BudgetAlertStoreApi {
  /** What was saved last, normalized; an empty record when there is nothing (usable) on disk. */
  load(): Promise<SentBudgetAlerts>
  save(sent: SentBudgetAlerts): Promise<void>
}

/**
 * budget-alerts.json, next to state.json: the budget notifications already sent (see budgetCrossings), so a
 * restart doesn't send them again. Never fails to load (a corrupt file gives its .bak, or nothing: at worst a
 * notification comes twice), and saves one at a time, as JsonFile needs.
 */
export class BudgetAlertStore implements BudgetAlertStoreApi {
  private readonly json: JsonFile<SentBudgetAlerts>
  private queue: Promise<void> = Promise.resolve()

  constructor(file: string) {
    this.json = new JsonFile(file, normalizeSentBudgetAlerts, emptySentBudgetAlerts)
  }

  async load(): Promise<SentBudgetAlerts> {
    try {
      return await this.json.load()
    } catch {
      return emptySentBudgetAlerts()
    }
  }

  save(sent: SentBudgetAlerts): Promise<void> {
    const run = this.queue.then(() => this.json.save(sent))
    this.queue = run.catch(() => {})
    return run
  }
}
