import 'dotenv/config'

let index = 0

function parseProxies(): string[] {
  const list = process.env.PROXIES?.split(',').map(s => s.trim()).filter(Boolean) || []
  if (list.length) return list
  const start = Number(process.env.PROXY_START_PORT || 0)
  const count = Number(process.env.PROXY_COUNT || 0)
  if (start > 0 && count > 0) return Array.from({ length: count }, (_, i) => `http://127.0.0.1:${start + i}`)
  return []
}

const proxies = parseProxies()

export function nextProxy(): string | undefined {
  if (!proxies.length) return undefined
  const p = proxies[index % proxies.length]
  index++
  return p
}


export function getProxy(country?: string): { server: string; username?: string; password?: string } | undefined {
  const host = process.env.PROXY_HOST
  const port = Number(process.env.PROXY_PORT)
  const username = process.env.PROXY_USER
  let password = `${process.env.PROXY_PASS}_country-${country}`
  if (!host || !port) return undefined
  return { server: `http://${host}:${port}`, username, password }
}



