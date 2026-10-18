import { DEFAULT_SETTINGS, normalizeSettings } from '../../shared/settings'
import type { Settings } from '../../shared/types'
import type { SettingsApi } from '../contracts'
import { JsonFile } from './jsonFile'

export interface SettingsStoreApi {
  load(): Promise<Settings>
  save(settings: Settings): Promise<void>
}

const defaults = (): Settings => normalizeSettings(DEFAULT_SETTINGS)

/**
 * settings.json, separate from state.json. Never fails to load: a missing file gives the defaults, a corrupt
 * one its .bak or else the defaults (settings are not worth refusing to start over). Values are normalized
 * on the way in and out, so unknown keys are dropped.
 */
export class SettingsStore implements SettingsStoreApi {
  private readonly json: JsonFile<Settings>

  constructor(file: string) {
    this.json = new JsonFile(file, (data) => normalizeSettings(data), defaults)
  }

  async load(): Promise<Settings> {
    try {
      return await this.json.load()
    } catch {
      return defaults()
    }
  }

  save(settings: Settings): Promise<void> {
    return this.json.save(normalizeSettings(settings))
  }
}

/** The current settings, in memory after init(); updates are normalized and saved one at a time. */
export class SettingsService implements SettingsApi {
  private current: Settings
  private queue: Promise<void> = Promise.resolve()

  /** `initial` is what `get()` returns until `init()` loads the saved settings. */
  constructor(
    private readonly store: SettingsStoreApi,
    initial: Settings = defaults(),
  ) {
    this.current = initial
  }

  async init(): Promise<void> {
    this.current = await this.store.load()
  }

  get(): Settings {
    return this.current
  }

  /** `patch` comes from the renderer: anything invalid in it is ignored and keeps the current value. */
  update(patch: Partial<Settings>): Promise<Settings> {
    const run = this.queue.then(async () => {
      const next = normalizeSettings({ ...this.current, ...(typeof patch === 'object' ? patch : {}) }, this.current)
      await this.store.save(next)
      this.current = next
      return next
    })
    this.queue = run.then(
      () => {},
      () => {},
    )
    return run
  }
}
