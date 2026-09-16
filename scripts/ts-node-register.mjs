import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('ts-node/esm', pathToFileURL('./'))

process.on('uncaughtException', (e) => {
  console.error('ERROR', e)
  throw e
})
