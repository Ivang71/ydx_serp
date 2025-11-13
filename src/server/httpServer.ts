import { createServer } from 'http'
import fs from 'fs'
import { URL } from 'url'
import { debug, error, info } from '../core/logger.js'
import { orchestrateSearch } from '../core/orchestrator.js'
import { stats } from '../core/stats.js'

export function startServer(port: number) {
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
          try { await fs.promises.writeFile('last.json', JSON.stringify(result, null, '\t')) } catch (e) { error('last_write_error', (e as any)?.message || e) }
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


