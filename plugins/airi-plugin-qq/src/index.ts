import process from 'node:process'

import { useLogg } from '@guiiai/logg'

import { QQAirIBridge } from './bridge'
import { loadConfig } from './config'

const log = useLogg('airi-plugin-qq').useGlobalConfig()

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

async function main(): Promise<void> {
  const config = loadConfig()
  const bridge = new QQAirIBridge(config)

  await bridge.start()

  log.log(`AIRI channel server: ${config.airi.url}`)
  log.log(`Group replies: ${config.behavior.groupRequireMention ? 'mention or trigger prefix only' : 'every message'}`)
  log.log('Point NapCat or LLOneBot at the WebSocket address above, then send a message.')

  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping)
      return

    stopping = true
    log.log(`Received ${signal}, shutting down`)
    await bridge.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error: unknown) => {
  log.withError(toError(error)).error('Failed to start the QQ bridge')
  process.exit(1)
})
