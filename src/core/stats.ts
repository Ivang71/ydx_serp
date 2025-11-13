import fs from 'fs'
import { error } from '../core/logger.js'

export const stats = { success: 0, failure: 0 }

setInterval(() => {
  try { fs.writeFileSync('stats.json', JSON.stringify(stats)) } catch (e) { error('stats_write_error', (e as any)?.message || e) }
}, 60_000)


