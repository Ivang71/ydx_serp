import { chromium } from 'playwright-extra'
import stealth from 'puppeteer-extra-plugin-stealth'
import { createServer } from 'http'
import fs from 'fs'
import { URL } from 'url'
import { getProxy } from './proxy.js'
import { COUNTRY_TO_LOCALE, pickRandomCountry } from './countries.js'

chromium.use(stealth())

function chromeArgs(): string[] {
  return [
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-first-run',
    '--safebrowsing-disable-auto-update',
    '--disable-client-side-phishing-detection',
    '--disable-default-apps',
    '--disable-variations',
    '--disable-quic',
    '--dns-prefetch-disable',
    '--disable-features=PreconnectToOrigins,PrefetchPrivacyChanges',
    '--disable-features=DnsOverHttps,AsyncDns',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-extensions',
    '--disable-web-security',
    '--fast-start',
    '--disable-blink-features=AutomationControlled',
    '--enable-blink-features=IdleDetection',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=VizDisplayCompositor',
    '--ignore-certificate-errors',
    '--disable-infobars'
  ]
}

type SearchItem = { text: string; links: string[] }
type TaskPayload = { query: string; timeoutMs: number; signal?: AbortSignal }

class TaskQueue<T> {
  private tasks: { value: T; resolve: (v: any) => void; reject: (e: any) => void }[] = []
  private waiters: ((task: { value: T; resolve: (v: any) => void; reject: (e: any) => void }) => void)[] = []
  enqueue(value: T) {
    return new Promise((resolve, reject) => {
      const task = { value, resolve, reject }
      const waiter = this.waiters.shift()
      if (waiter) waiter(task)
      else this.tasks.push(task)
    })
  }
  next() {
    return new Promise<{ value: T; resolve: (v: any) => void; reject: (e: any) => void }>(resolve => {
      const t = this.tasks.shift()
      if (t) resolve(t)
      else this.waiters.push(resolve)
    })
  }
}

async function searchOnce(browser: any, locale: string, acceptLanguage: string, query: string, timeoutMs: number, signal?: AbortSignal): Promise<SearchItem[]> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale, extraHTTPHeaders: { 'Accept-Language': acceptLanguage } })
  try {
    await context.route('**/*', (route: any) => {
      const req = route.request()
      const url = req.url()
      const type = req.resourceType()
      if (type === 'image' || type === 'font') return route.abort()
      if (/\.(?:jpe?g|png|webp|avif|woff2?|ttf|otf)(?:[?#]|$)/i.test(url)) return route.abort()
      return route.continue()
    })
    await context.addInitScript(() => {
      delete (window as any).navigator.webdriver
      delete (window as any).navigator.__proto__?.webdriver
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true, enumerable: true })
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 })
      ;(window as any).chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) }
      try {
        const originalQuery = window.navigator.permissions.query
        ;(window.navigator.permissions as any).query = (parameters: any) => {
          if ((parameters as any).name === 'notifications') return Promise.resolve({ state: Notification.permission })
          return (originalQuery as any).call(window.navigator.permissions, parameters)
        }
      } catch {}
    })
    const page = await context.newPage()
    if (signal?.aborted) throw new Error('aborted')
    let needRelaunch = false
    page.on('framenavigated', (frame: any) => {
      try { if (frame === page.mainFrame() && /captcha/i.test(frame.url())) needRelaunch = true } catch {}
    })
    const abortPromise = new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    const url = `https://ya.ru/search/?text=${encodeURIComponent(query)}`
    await Promise.race([
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }),
      abortPromise
    ])
    if (needRelaunch) throw new Error('captcha')
    await Promise.race([
      page.waitForSelector('h2#RelatedBottom', { timeout: timeoutMs }),
      abortPromise
    ])
    await context.route('**/*', (r: any) => r.abort())
    const items = await page.evaluate(() => {
      const out: { text: string; links: string[] }[] = []
      const seen = new Set<string>()
      document.querySelectorAll('#search-result > li').forEach(li => {
        const clone = (li as HTMLElement).cloneNode(true) as HTMLElement
        clone.querySelectorAll('[class]').forEach(node => {
          if (/subtitle/i.test(node.getAttribute('class') || '')) node.remove()
        })
        let text = (clone.innerText || '')
          .replace(/[\t\r\n]+/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .replace(/([a-zа-яё])([A-ZА-ЯЁ])/g, '$1 $2')
          .trim()
        const fast = (li.getAttribute('data-fast-name') || '').trim()
        const isFuturis = ((li.getAttribute('class') || '').toLowerCase().includes('futuris'))
        const anchors = Array.from(li.querySelectorAll('a[href]')) as HTMLAnchorElement[]
        let links: string[] = []
        if (isFuturis) links = anchors.map(a => a.href)
        else if (fast === 'video-unisearch') links = []
        else if (anchors[0]) links = [anchors[0].href]
        if (links.length) links = links.filter(u => { if (seen.has(u)) return false; seen.add(u); return true })
        out.push({ text, links })
      })
      return out
    })
    return items
  } finally {
    try { await context.close() } catch {}
  }
}

class BrowserWorker {
  private browser: any | null = null
  private country: string
  private locale: string
  private acceptLanguage: string
  constructor(private queue: TaskQueue<TaskPayload>, private id: number) {
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
        console.log('worker_search_start', { worker: this.id, country: this.country, q: task.value.query })
        const items = await searchOnce(this.browser, this.locale, this.acceptLanguage, task.value.query, task.value.timeoutMs, task.value.signal)
        console.log('worker_search_ok', { worker: this.id, items: items.length })
        task.resolve(items)
      } catch (err) {
        if ((err as any)?.message === 'aborted') { task.reject(err); continue }
        console.error('worker_search_error_relaunch', { worker: this.id })
        await this.relaunch()
        try {
          const items = await searchOnce(this.browser, this.locale, this.acceptLanguage, task.value.query, task.value.timeoutMs, task.value.signal)
          console.log('worker_search_ok_after_relaunch', { worker: this.id, items: items.length })
          task.resolve(items)
        } catch (e) {
          if ((e as any)?.message === 'aborted') { task.reject(e) }
          else {
            console.error('worker_search_error_fail', { worker: this.id, error: (e as any)?.message || e })
            task.reject(e)
          }
        }
      }
    }
  }
  private async launch() {
    const options: Parameters<typeof chromium.launch>[0] = { headless: process.env.HEADLESS !== '0', args: chromeArgs(), proxy: getProxy(this.country) }
    console.log('worker_launch', { worker: this.id, country: this.country })
    this.browser = await chromium.launch(options)
  }
  private async relaunch() {
    try { await this.browser?.close() } catch {}
    this.country = pickRandomCountry()
    this.locale = COUNTRY_TO_LOCALE[this.country]
    const lang = this.locale.split('-')[0]
    this.acceptLanguage = `${this.locale},${lang};q=0.9`
    console.log('worker_relaunch', { worker: this.id, country: this.country })
    await this.launch()
  }
}

const queue = new TaskQueue<TaskPayload>()

function startWorkers(n: number) {
  for (let i = 0; i < n; i++) {
    const w = new BrowserWorker(queue, i)
    w.start().catch(() => {})
  }
}

async function orchestrateSearch(query: string): Promise<SearchItem[]> {
  const TOTAL_MS = Number(36000)
  const ATTEMPT_MS = Math.max(1000, Math.floor(TOTAL_MS / 4))
  const attemptOne = (): Promise<SearchItem[]> => {
    const c = new AbortController()
    const p = queue.enqueue({ query, timeoutMs: ATTEMPT_MS, signal: c.signal }) as Promise<SearchItem[]>
    return p.finally(() => c.abort())
  }
  const attemptParallel = (): Promise<SearchItem[]> => {
    const c1 = new AbortController()
    const c2 = new AbortController()
    const p1 = queue.enqueue({ query, timeoutMs: ATTEMPT_MS, signal: c1.signal }) as Promise<SearchItem[]>
    const p2 = queue.enqueue({ query, timeoutMs: ATTEMPT_MS, signal: c2.signal }) as Promise<SearchItem[]>
    const raced = Promise.any<SearchItem[]>([p1, p2])
    raced.finally(() => { c1.abort(); c2.abort() })
    return raced
  }
  try { return await attemptOne() } catch {}
  try { return await attemptParallel() } catch {}
  try { return await attemptParallel() } catch {}
  return attemptParallel()
}

function startServer(port: number) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '', `http://${req.headers.host}`)
      if (req.method !== 'GET' || url.pathname !== '/search') {
        res.statusCode = 404
        res.end()
        return
      }
      const q = (url.searchParams.get('q') || '').trim()
      if (!q) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'missing q' }))
        return
      }
      console.log('request_received', { q })
      try {
        const result = await orchestrateSearch(q)
        console.log('request_respond', { items: (result as any[])?.length })
        stats.success++
        if (process.env.DEBUG) {
          try { await fs.promises.writeFile(process.env.LAST_FILE || 'last.json', JSON.stringify(result, null, '\t')) } catch (e) { console.error('last_write_error', (e as any)?.message || e) }
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(result))
      } catch (e) {
        stats.failure++
        console.error('request_error', { error: (e as any)?.stack || (e as any)?.message || e })
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'internal' }))
      }
    } catch (e) {
      console.error('request_error', { error: (e as any)?.stack || (e as any)?.message || e })
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'internal' }))
    }
  })
  server.listen(port)
  console.log('server_listening', { port })
}

const PORT = Number(process.env.PORT || 3000)
const NUMBER_OF_BROWSERS = Math.max(1, Number(process.env.NUMBER_OF_BROWSERS || 2))
startWorkers(NUMBER_OF_BROWSERS)
startServer(PORT)

const stats = { success: 0, failure: 0 }
const STATS_FILE = process.env.STATS_FILE || 'stats.json'
setInterval(() => {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats)) } catch (e) { console.error('stats_write_error', (e as any)?.message || e) }
}, 60_000)

process.on('unhandledRejection', err => {
  console.error('unhandledRejection', err)
})
process.on('uncaughtException', err => {
  console.error('uncaughtException', err)
})

