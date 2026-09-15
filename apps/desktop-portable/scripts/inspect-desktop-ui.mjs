#!/usr/bin/env node
/** Inspect the packaged Desktop renderer over a temporary Chromium debugging endpoint. */

const port = Number(process.argv[2])
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('inspect desktop UI: expected a Chromium debugging port')
}

const deadline = Date.now() + 60_000
let target
while (Date.now() < deadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (response.ok) {
      const targets = await response.json()
      target = targets.find(candidate => candidate.type === 'page' && candidate.url.startsWith('dsh-app://app/'))
      if (target !== undefined) break
    }
  } catch {}
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
}
if (target === undefined) throw new Error('inspect desktop UI: application page did not open')

const text = await new Promise((resolvePromise, reject) => {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const timer = setTimeout(() => {
    socket.close()
    reject(new Error('inspect desktop UI: Runtime.evaluate timed out'))
  }, 30_000)
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'document.body.innerText', returnByValue: true } }))
  })
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    if (message.id !== 1) return
    clearTimeout(timer)
    socket.close()
    const value = message.result?.result?.value
    if (typeof value !== 'string') reject(new Error('inspect desktop UI: renderer text was unavailable'))
    else resolvePromise(value)
  })
  socket.addEventListener('error', () => {
    clearTimeout(timer)
    reject(new Error('inspect desktop UI: debugging connection failed'))
  })
})

if (!/(?:API Key|API 密钥|API 金鑰)/iu.test(text)) {
  throw new Error('inspect desktop UI: first-use API key onboarding is not visible')
}
if (!/(?:DeepSeek|Provider|提供方|供應商)/iu.test(text)) {
  throw new Error('inspect desktop UI: model provider onboarding is not visible')
}
console.log('Desktop UI shows first-use API key/provider onboarding.')
