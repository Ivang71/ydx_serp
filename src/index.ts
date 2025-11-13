import { chromium } from 'playwright-extra'
import stealth from 'puppeteer-extra-plugin-stealth'
import { startWorkers } from './workers/worker.js'
import { queue } from './core/orchestrator.js'
import { startServer } from './server/httpServer.js'
import { error } from './core/logger.js'

chromium.use(stealth())

const PORT = Number(process.env.PORT || 3000)
const NUMBER_OF_WORKERS = Math.max(1, Number(process.env.NUMBER_OF_WORKERS || 2))
startWorkers(NUMBER_OF_WORKERS, queue)
startServer(PORT)

process.on('unhandledRejection', err => {
  // error('unhandledRejection', err)
})
process.on('uncaughtException', err => {
  // error('uncaughtException', err)
})

