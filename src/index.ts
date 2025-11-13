import { chromium } from 'playwright-extra'
import stealth from 'puppeteer-extra-plugin-stealth'
import { createServer } from 'http'
import fs from 'fs'
import { URL } from 'url'
import { getProxy } from './proxy.js'
import { COUNTRY_TO_LOCALE, pickRandomCountry } from './countries.js'
import { debug, info, error } from './logger.js'
import type { Route } from 'playwright'
import path from 'path'
import { createHash } from 'crypto'

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
type TaskPayload = { query: string; timeoutMs: number; getAiAnswer: boolean; signal?: AbortSignal }

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

const CACHE_DIR = process.env.CACHE_DIR || '.http_cache'
function keyFor(method: string, url: string) {
  return createHash('sha256').update(method.toUpperCase() + ' ' + url).digest('hex')
}
function filePathsFor(key: string) {
  const a = key.slice(0, 2)
  const b = key.slice(2, 4)
  const dir = path.join(CACHE_DIR, a, b)
  return { dir, body: path.join(dir, key + '.body'), meta: path.join(dir, key + '.json') }
}
async function readCached(method: string, url: string) {
  try {
    const key = keyFor(method, url)
    const p = filePathsFor(key)
    const [metaRaw, body] = await Promise.all([
      fs.promises.readFile(p.meta, 'utf8'),
      fs.promises.readFile(p.body)
    ])
    const meta = JSON.parse(metaRaw)
    return { status: meta.status as number, headers: meta.headers as Record<string, string>, body }
  } catch { return null }
}
async function writeCached(method: string, url: string, status: number, headers: Record<string, string>, body: Buffer) {
  try {
    const key = keyFor(method, url)
    const p = filePathsFor(key)
    await fs.promises.mkdir(p.dir, { recursive: true })
    const meta = JSON.stringify({ url, method, status, headers })
    const tmpB = p.body + '.tmp'
    const tmpM = p.meta + '.tmp'
    await fs.promises.writeFile(tmpB, body)
    await fs.promises.writeFile(tmpM, meta, 'utf8')
    await Promise.all([
      fs.promises.rename(tmpB, p.body),
      fs.promises.rename(tmpM, p.meta)
    ])
  } catch {}
}

async function searchOnce(browser: any, locale: string, acceptLanguage: string, query: string, timeoutMs: number, signal: AbortSignal | undefined, getAiAnswer: boolean): Promise<SearchItem[]> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale, extraHTTPHeaders: { 'Accept-Language': acceptLanguage } })
  try {
    await context.route(/\.(?:jpg|jpeg|webp|woff|woff2|eot|ttf|otf|ico|svg)(?:[?#]|$)/i, (route: Route) => route.abort())
    let captchaReject: ((e: any) => void) | null = null
    const captchaPromise = new Promise<never>((_, reject) => { captchaReject = reject })
    await context.route('**/*', async (route: Route) => {
      const req = route.request()
      if (req.resourceType() === 'font') return route.abort()
      if (/captcha/i.test(req.url())) {
        captchaReject?.(new Error('captcha'))
        return route.abort()
      }
      if (req.resourceType() === 'document') return route.continue()
      const method = req.method()
      if (method !== 'GET' && method !== 'HEAD') return route.continue()
      const url = req.url()
      const hit = await readCached(method, url)
      if (hit) {
        // debug('cache_hit', { url })
        return route.fulfill({ status: hit.status, headers: hit.headers, body: method === 'HEAD' ? undefined : hit.body })
      }
      const resp = await route.fetch()
      const status = resp.status()
      const headers = await resp.headers()
      const body = method === 'HEAD' ? Buffer.alloc(0) : await resp.body()
      route.fulfill({ status, headers, body })
      const ct = String((headers as any)['content-type'] || '')
      if (!/html/i.test(ct)) writeCached(method, url, status, headers as any, body).catch(() => {})
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
    const abortPromise = new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    const url = `https://ya.ru/search/?text=${encodeURIComponent(query)}`
    await Promise.race([
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }),
      abortPromise,
      captchaPromise
    ])
    await Promise.race([
      page.waitForSelector('footer', { timeout: timeoutMs }).catch(() => null),
      abortPromise,
      captchaPromise
    ])
    // If requested, wait for Futuris AI answer to mount
    if (getAiAnswer) {
      try {
        const selector = '#search-result > li[data-fast-subtype="teaser_gen_answer"]'
        const cardSelector = `${selector} .FuturisMarkdown`
        const AI_TIMEOUT_MS = 40_000
        const AI_DETECT_MS = 3_000
        await Promise.race([
          page.waitForSelector(selector, { timeout: AI_DETECT_MS }),
          abortPromise
        ]).catch(() => null)
        const hasAiTeaser = await page.$(selector)
        debug('ai_teaser_present', { present: !!hasAiTeaser })
        if (hasAiTeaser) {
          await Promise.race([
            page.waitForSelector(cardSelector, { timeout: AI_TIMEOUT_MS }),
            abortPromise
          ])
          debug('ai_teaser_card_ready')
        }
      } catch (e) {
        error('ai_teaser_error', { error: (e as any)?.message || e })
      }
    }
    // Do not abort all network requests; allow further fetches so AI card can load
    const items = await page.evaluate(() => {
      const out: { text: string; links: string[] }[] = []
      const seen = new Set<string>()
      document.querySelectorAll('#search-result > li').forEach(li => {
        const clone = (li as HTMLElement).cloneNode(true) as HTMLElement
        clone.querySelectorAll('[class]').forEach(node => {
          if (/subtitle/i.test(node.getAttribute('class') || '')) node.remove()
        })
        const fast = (li.getAttribute('data-fast-name') || '').trim()
        const isFuturis = ((li.getAttribute('class') || '').toLowerCase().includes('futuris'))
        const anchors = Array.from(li.querySelectorAll('a[href]')) as HTMLAnchorElement[]
        let links: string[] = []
        let text = (clone.innerText || '')
          .replace(/[\t\r\n]+/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .replace(/([a-zа-яё])([A-ZА-ЯЁ])/g, '$1 $2')
          .trim()
        if (isFuturis) {
          const md = li.querySelector('.FuturisMarkdown') as HTMLElement | null
          if (md) {
            const mdText = (md.innerText || '')
              .replace(/[\t\r\n]+/g, ' ')
              .replace(/\s{2,}/g, ' ')
              .replace(/([a-zа-яё])([A-ZА-ЯЁ])/g, '$1 $2')
              .trim()
            if (mdText) text = mdText
          }
        }
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
    // try { await context.close() } catch {}
  }
}

class BrowserWorker {
  private browser: any | null = null
  private country!: string
  private locale!: string
  private acceptLanguage!: string
  constructor(private queue: TaskQueue<TaskPayload>, private id: number) {
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
      const items = await searchOnce(this.browser, this.locale, this.acceptLanguage, query, timeoutMs, signal, getAiAnswer)
      debug('worker_search_ok', { worker: this.id, items: items.length })
      return items
    } catch (err) {
      if ((err as any)?.message === 'aborted') throw err
      error('worker_search_error_relaunch', { worker: this.id })
      await this.relaunch()
      try {
        const items = await searchOnce(this.browser, this.locale, this.acceptLanguage, query, timeoutMs, signal, getAiAnswer)
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

const queue = new TaskQueue<TaskPayload>()

function startWorkers(n: number) {
  for (let i = 0; i < n; i++) {
    const w = new BrowserWorker(queue, i)
    w.start().catch(() => {})
  }
}

async function orchestrateSearch(query: string, getAiAnswer: boolean): Promise<SearchItem[]> {
  const TOTAL_MS = Number(36000)
  const ATTEMPT_MS = Math.max(1000, Math.floor(TOTAL_MS / 4))
  const attemptOne = (): Promise<SearchItem[]> => {
    const c = new AbortController()
    const p = queue.enqueue({ query, timeoutMs: ATTEMPT_MS, getAiAnswer, signal: c.signal }) as Promise<SearchItem[]>
    return p.finally(() => c.abort())
  }
  const attemptParallel = (): Promise<SearchItem[]> => {
    const c1 = new AbortController()
    const c2 = new AbortController()
    const p1 = queue.enqueue({ query, timeoutMs: ATTEMPT_MS, getAiAnswer, signal: c1.signal }) as Promise<SearchItem[]>
    const p2 = queue.enqueue({ query, timeoutMs: ATTEMPT_MS, getAiAnswer, signal: c2.signal }) as Promise<SearchItem[]>
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
      const getAiAnswerParam = url.searchParams.get('getAiAnswer')
      const getAiAnswer = getAiAnswerParam == null ? true : !/^(0|false)$/i.test(getAiAnswerParam)
      if (!q) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'missing q' }))
        return
      }
      debug('request_received', { q, getAiAnswer })
      try {
        const result = await orchestrateSearch(q, getAiAnswer)
        debug('request_respond', { items: (result as any[])?.length })
        stats.success++
        if (process.env.DEBUG) {
          try { await fs.promises.writeFile(process.env.LAST_FILE || 'last.json', JSON.stringify(result, null, '\t')) } catch (e) { error('last_write_error', (e as any)?.message || e) }
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(result))
      } catch (e) {
        stats.failure++
        error('request_error', { error: (e as any)?.stack || (e as any)?.message || e })
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'internal' }))
      }
    } catch (e) {
      error('request_error', { error: (e as any)?.stack || (e as any)?.message || e })
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'internal' }))
    }
  })
  server.listen(port)
  info('server_listening', { port })
}

const PORT = Number(process.env.PORT || 3000)
const NUMBER_OF_BROWSERS = Math.max(1, Number(process.env.NUMBER_OF_BROWSERS || 2))
startWorkers(NUMBER_OF_BROWSERS)
startServer(PORT)

const stats = { success: 0, failure: 0 }
const STATS_FILE = process.env.STATS_FILE || 'stats.json'
setInterval(() => {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats)) } catch (e) { error('stats_write_error', (e as any)?.message || e) }
}, 60_000)

process.on('unhandledRejection', err => {
  error('unhandledRejection', err)
})
process.on('uncaughtException', err => {
  error('uncaughtException', err)
})

