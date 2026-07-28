'use strict'

/**
 * redirect.js — Minimal 301 redirect server.
 * Used by the orphan "prono" (prono-dggr.onrender.com) service so it sends
 * all traffic to the main "prono-api" dashboard.
 */
const http = require('http')

const TARGET = process.env.REDIRECT_TARGET || 'https://prono-api-7mhs.onrender.com'

const server = http.createServer((req, res) => {
  const path = req.url && req.url.length ? req.url : '/'
  const location = TARGET + path
  res.writeHead(301, {
    Location: location,
    'Cache-Control': 'no-store',
    Connection: 'close',
  })
  res.end(`Redirecting to ${location}`)
})

const port = parseInt(process.env.PORT, 10) || 10000
server.listen(port, () => {
  console.log(`🔀 Redirect server listening on :${port} -> ${TARGET}`)
})
