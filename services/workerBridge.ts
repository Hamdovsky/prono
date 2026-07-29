// @ts-nocheck
import axios from 'axios'
import logger from '../core/logger'

const workerUrl = process.env.SCRAPER_WORKER_URL || ''
const apiKey = process.env.API_SECRET_KEY || ''

async function callWorker(endpoint, body = {}) {
  if (!workerUrl) {
    logger.warn(`[WORKER BRIDGE] No SCRAPER_WORKER_URL set — cannot call ${endpoint}`)
    return null
  }
  try {
    const { data } = await axios.post(`${workerUrl}/${endpoint}`, body, {
      headers: { 'x-api-key': apiKey },
      timeout: 300000,
    })
    return data
  } catch (err) {
    logger.warn(`[WORKER BRIDGE] ${endpoint} failed: ${err.message}`)
    return null
  }
}

export = { callWorker }
