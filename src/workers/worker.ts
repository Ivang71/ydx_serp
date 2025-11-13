import { chromium } from 'playwright-extra'
import { chromeArgs } from '../config/chromeArgs.js'
import { getProxy } from '../config/proxy.js'
import { COUNTRY_TO_LOCALE, pickRandomCountry } from '../config/countries.js'
import { debug, error } from '../core/logger.js'
import type { SearchItem } from '../types.js'
import { searchAlice } from '../execution/alice.js'
import type { TaskQueue } from '../core/taskQueue.js'

export class BrowserWorker {
  private browser: any | null = null
  private country!: string
  private locale!: string
  private acceptLanguage!: string
  constructor(private queue: TaskQueue<any>, private id: number) {
    this.updateRegion()
  }
  private updateRegion() {
    this.country = pickRandomCountry()
    this.locale = COUNTRY_TO_LOCALE[this.country]
    const lang = this.locale.split('-')[0]
    this.acceptLanguage = `${this.locale},${lang};q=0.9`
  }
  async start() {
    await this.launch()
    for (;;) {
      const task = await this.queue.next()
      try {
        if (!this.browser) await this.launch()
        debug('worker_search_start', { worker: this.id, country: this.country, q: task.value.query })
        const items = await this.performSearch(task.value.query, task.value.timeoutMs, task.value.signal, task.value.getAiAnswer)
        task.resolve(items)
      } catch (err) {
        task.reject(err)
      }
    }
  }
  private async performSearch(query: string, timeoutMs: number, signal: AbortSignal | undefined, getAiAnswer: boolean): Promise<SearchItem[]> {
    try {
      const items = await searchAlice(this.browser, this.locale, this.acceptLanguage, query, timeoutMs, signal, getAiAnswer)
      debug('worker_search_ok', { worker: this.id, items: items.length })
      return items
    } catch (err) {
      if ((err as any)?.message === 'aborted') throw err
      error('worker_search_error_relaunch', { worker: this.id })
      await this.relaunch()
      try {
        const items = await searchAlice(this.browser, this.locale, this.acceptLanguage, query, timeoutMs, signal, getAiAnswer)
        debug('worker_search_ok_after_relaunch', { worker: this.id, items: items.length })
        return items
      } catch (e) {
        if ((e as any)?.message === 'aborted') throw e
        error('worker_search_error_fail', { worker: this.id, error: (e as any)?.message || e })
        throw e
      }
    }
  }
  private async launch() {
    const options: Parameters<typeof chromium.launch>[0] = { headless: process.env.HEADLESS !== '0', devtools: true, args: chromeArgs(), proxy: getProxy(this.country) }
    debug('worker_launch', { worker: this.id, country: this.country })
    this.browser = await chromium.launch(options)
  }
  private async relaunch() {
    this.updateRegion()
    debug('worker_relaunch', { worker: this.id, country: this.country })
    await this.launch()
  }
}

export function startWorkers<T>(n: number, queue: TaskQueue<T>) {
  for (let i = 0; i < n; i++) {
    const w = new BrowserWorker(queue as unknown as TaskQueue<any>, i)
    w.start().catch(() => {})
  }
}


