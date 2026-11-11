// Step "Write audit context" of build-review-crush.yml: writes the files that
// tell the auditor which build changes to expect, and audit-rules.md, the
// audit contract. "Assemble build repo" commits audit-rules.md as AGENTS.md,
// which crush loads as context in the parent and in every worker (both run
// in a copy of the repo), and "Build review prompt" puts it in the prompt.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { codeList, env, fill, output, readTemplate, runToFile, words } from './lib.mjs'

const TAG = env('TAG')
const BASE_TAG = env('BASE_TAG')
const OUTPUT_DIR = env('OUTPUT_DIR')
const WORK_DIR = env('WORK_DIR')
const CONTEXT_DIR = env('CONTEXT_DIR')
const SOURCE_PATHS = words(env('SOURCE_PATHS'))
const EXCLUDED_FILES = words(env('EXCLUDED_FILES'))
const COPIED_FILES = words(env('COPIED_FILES'))

fs.mkdirSync(CONTEXT_DIR, { recursive: true })
// The build inputs. Build changes that they do not explain are what the
// audit looks for.
runToFile(path.join(CONTEXT_DIR, 'source.diff'), 'git', [
  'diff', `refs/tags/${BASE_TAG}`, `refs/tags/${TAG}`, '--', ...SOURCE_PATHS
])
runToFile(path.join(CONTEXT_DIR, 'commits.txt'), 'git', [
  'log', '--no-decorate', '--format=%h %s', `refs/tags/${BASE_TAG}..refs/tags/${TAG}`
])

let toolchain = `Node ${output('node', ['--version']).trim()}, npm ${output('npm', ['--version']).trim()}\n`
if (env('DENO_VERSION')) {
  toolchain += output('deno', ['--version'])
}
const dependencyListCommand = env('DEPENDENCY_LIST_COMMAND')
if (dependencyListCommand) {
  for (const [dir, tag] of [['base-src', BASE_TAG], ['release-src', TAG]]) {
    const cwd = `${WORK_DIR}/${dir}`
    toolchain += `\nTop-level dependencies of ${tag} (${cwd}):\n`
    // The exit code does not matter: `npm ls` also lists the dependencies
    // when it exits with 1 because it found a problem.
    const list = spawnSync('bash', ['-c', dependencyListCommand], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 30
    })
    toolchain += list.stdout ?? ''
  }
}
fs.writeFileSync(path.join(CONTEXT_DIR, 'toolchain.txt'), toolchain)

// The notes about the build output follow the paragraph about `built/`. The
// caller's build-notes are added as they are, without placeholders.
const outputNotes = []
if (EXCLUDED_FILES.length > 0) {
  outputNotes.push(`Built files with these names are left out and not audited: ${codeList(EXCLUDED_FILES)}.`)
}
if (COPIED_FILES.length > 0) {
  outputNotes.push(`Built files with these paths in \`built/\` are left out: ${codeList(COPIED_FILES)}. The workflow checked that each one equals a file that git tracks at the same tag outside \`${OUTPUT_DIR}/\`, so the build added nothing to it.`)
}
const buildNotes = env('BUILD_NOTES').replace(/\n+$/, '')
if (buildNotes) {
  outputNotes.push(buildNotes)
}
let template = readTemplate('audit-rules.md')
if (outputNotes.length === 0) {
  // Drops the @OUTPUT_NOTES@ paragraph.
  template = template.replace('\n@OUTPUT_NOTES@\n', '')
}
const rules = fill(template, {
  PACKAGE_NAME: env('PACKAGE_NAME'),
  OUTPUT_DIR,
  SOURCE_LIST: codeList(SOURCE_PATHS),
  BASE_TAG,
  TAG,
  CONTEXT_DIR,
  WORK_DIR,
  OUTPUT_NOTES: outputNotes.join('\n\n')
})
fs.writeFileSync(path.join(CONTEXT_DIR, 'audit-rules.md'), rules)
