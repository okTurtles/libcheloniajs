import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import packageJson from './package.json' with { type: 'json' }
import { fork, spawn } from 'node:child_process'

type Opts = { type: string, tscArgs: string[], renameFileArgs: string[] }

const optionsMap: Record<string, Opts> = {
  esm: {
    type: 'module',
    tscArgs: ['--project', 'tsconfig.json', '--declaration'],
    renameFileArgs: ['esm']
  },
  cjs: {
    type: 'commonjs',
    tscArgs: ['--project', 'tsconfig.cjs.json', '--declaration'],
    renameFileArgs: ['cjs']
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))

const withTempTypeWrapper = async (newType: string, run: () => Promise<void> | void) => {
  const suffix = crypto.randomUUID()
  const tempFilePath = join(__dirname, `~$package.json.${suffix}`)
  const packageJsonPath = join(__dirname, 'package.json')
  await fs.copyFile(packageJsonPath, tempFilePath)
  try {
    const newContents = structuredClone(packageJson)
    newContents.type = newType
    await fs.writeFile(packageJsonPath, JSON.stringify(newContents, undefined, 2))
    await run()
  } finally {
    await fs.copyFile(tempFilePath, packageJsonPath, fs.constants.COPYFILE_FICLONE)
    await fs.unlink(tempFilePath)
  }
}

const buildInternal = async (opts: Opts) => {
  await new Promise<void>((resolve, reject) => {
    const tsc = spawn('tsc', opts.tscArgs, {
      env: {
        ...process.env,
        PATH: [join(__dirname, 'node_modules', '.bin'), process.env.PATH].filter(Boolean).join(':')
      }
    })
    tsc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`[tsc] code ${code}`))
      } else {
        resolve()
      }
      tsc.stdin.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    const rename = fork(new URL('./renameFiles.mjs', import.meta.url), opts.renameFileArgs)
    rename.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`[rename] code ${code}`))
      } else {
        resolve()
      }
      rename.stdin?.end()
    })
  })
}

const build = async (opts: Opts) => {
  if (packageJson.type !== opts.type) {
    return withTempTypeWrapper(opts.type, () => buildInternal(opts))
  } else {
    return buildInternal(opts)
  }
}

if (process.argv[2] === 'esm') {
  await build(optionsMap.esm)
} else if (process.argv[2] === 'cjs') {
  await build(optionsMap.cjs)
} else {
  console.error('Invalid build type')
}
