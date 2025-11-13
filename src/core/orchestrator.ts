import { TaskQueue } from './taskQueue.js'
import type { TaskPayload, SearchItem } from '../types.js'

export const queue = new TaskQueue<TaskPayload>()

export async function orchestrateSearch(query: string, getAiAnswer: boolean): Promise<SearchItem[]> {
  const TOTAL_MS = Number(36000)
  const ATTEMPT_MS = Math.max(1000, Math.floor(TOTAL_MS / 4))
  const attemptParallel = (): Promise<SearchItem[]> => {
    const parallel = Math.max(1, Number(process.env.PARALLEL_REQUESTS || 2))
    const controllers = Array.from({ length: parallel }, () => new AbortController())
    const promises = controllers.map(c =>
      queue.enqueue({ query, timeoutMs: ATTEMPT_MS, getAiAnswer, signal: c.signal }) as Promise<SearchItem[]>
    )
    const raced = Promise.any<SearchItem[]>(promises)
    raced.finally(() => { controllers.forEach(c => c.abort()) })
    return raced
  }
  try { return await attemptParallel() } catch {}
  try { return await attemptParallel() } catch {}
  try { return await attemptParallel() } catch {}
  return attemptParallel()
}


