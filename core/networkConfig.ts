import http from 'http'
import https from 'https'

const options = {
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 16,
  timeout: 30000,
  scheduling: 'fifo' as const,
}

const httpAgent = new http.Agent(options)
const httpsAgent = new https.Agent(options)

let undiciAgent: null = null

function getUndiciAgent(): null {
  return null
}

function getAgent(url?: string): http.Agent | https.Agent {
  if (!url) return httpsAgent
  return url.startsWith('https') ? httpsAgent : httpAgent
}

const pooledConfig = {
  httpAgent,
  httpsAgent,
  timeout: 10000,
  maxSockets: 64,
  maxFreeSockets: 16,
  retries: 3,
  retryDelay: 1000,
  keepAlive: true,
  scheduling: 'fifo' as const,
}

export {
  httpAgent,
  httpsAgent,
  getUndiciAgent,
  getAgent,
  pooledConfig,
}
