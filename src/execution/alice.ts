import type { Route } from 'playwright'
import type { SearchItem } from '../types.js'
import { readCached, writeCached } from '../core/cache.js'

export async function searchAlice(browser: any, locale: string, acceptLanguage: string, query: string, timeoutMs: number, signal: AbortSignal | undefined, getAiAnswer: boolean): Promise<SearchItem[]> {
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
        return route.fulfill({ status: hit.status, headers: hit.headers, body: method === 'HEAD' ? undefined : hit.body })
      }
      const resp = await route.fetch()
      const status = resp.status()
      const headers = resp.headers()
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
    const url = `https://alice.yandex.ru/`
    await Promise.race([
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }),
      abortPromise,
      captchaPromise
    ])
    await Promise.race([
      page.waitForSelector('body', { timeout: timeoutMs }).catch(() => null),
      abortPromise,
      captchaPromise
    ])
    await Promise.race([
      page.waitForSelector('.AliceInput, input.AliceInput, .AliceInput input, .AliceInput textarea, textarea.AliceInput', { timeout: timeoutMs }).catch(() => null),
      abortPromise,
      captchaPromise
    ])
    const selector = '.AliceInput input, input.AliceInput, .AliceInput textarea, textarea.AliceInput'
    try {
      await page.fill(selector, query, { timeout: Math.max(500, Math.floor(timeoutMs / 2)) })
    } catch {}
    try {
      await page.focus(selector)
      for (let i = 0; i < 3; i++) {
        if (signal?.aborted) throw new Error('aborted')
        await page.press(selector, 'Enter')
        await page.waitForTimeout(25)
      }
    } catch {}
    await Promise.race([
      page.waitForFunction(() => {
        const el = document.querySelector('.StandaloneOknyxCore-Logo') as HTMLElement | null
        if (!el) return false
        const inlineDisplay = el.style && el.style.display
        const computedDisplay = window.getComputedStyle(el).display
        return (!inlineDisplay || inlineDisplay === '') && computedDisplay !== 'none'
      }, { timeout: timeoutMs }).catch(() => null),
      abortPromise,
      captchaPromise
    ])
    await Promise.race([
      page.waitForSelector('.FuturisMarkdown', { timeout: timeoutMs }).catch(() => null),
      abortPromise,
      captchaPromise
    ])
    let aiText = ''
    try {
      aiText = await page.$eval('.FuturisMarkdown', (el: any) => (el.textContent || '').trim())
    } catch {}
    const items: SearchItem[] = [{ text: aiText, links: [] }]
    return items
  } finally {
    try { await context.close() } catch {}
  }
}


