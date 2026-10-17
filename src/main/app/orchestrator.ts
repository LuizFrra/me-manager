import type { AppService, OrchestratorDeps } from '../contracts'

export class Orchestrator implements AppService {
  constructor(private readonly deps: OrchestratorDeps) {}
  async init(): Promise<void> {
    void this.deps
  }
  getState = notImplemented
  getStatus = notImplemented
  createTheme = notImplemented
  removeTheme = notImplemented
  addRepo = notImplemented
  addFolder = notImplemented
  removeItem = notImplemented
  createTask = notImplemented
  checkTaskRemoval = notImplemented
  removeTask = notImplemented
  openTarget = notImplemented
  listTabs = notImplemented
  newTab = notImplemented
  selectTab = notImplemented
  closeTab = notImplemented
  restartClaude = notImplemented
}

function notImplemented(): never {
  throw new Error('Orchestrator not implemented yet')
}
