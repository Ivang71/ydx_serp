import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'

function keyFor(method: string, url: string) {
  return createHash('sha256').update(method.toUpperCase() + ' ' + url).digest('hex')
}
function filePathsFor(key: string) {
  const a = key.slice(0, 2)
  const b = key.slice(2, 4)
  const dir = path.join('.http_cache', a, b)
  return { dir, body: path.join(dir, key + '.body'), meta: path.join(dir, key + '.json') }
}
export async function readCached(method: string, url: string) {
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
export async function writeCached(method: string, url: string, status: number, headers: Record<string, string>, body: Buffer) {
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


