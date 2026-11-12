// Step "Run build review" of build-review-crush.yml: runs crush with the
// prompt of "Build review prompt" in the build repo, in the same sandbox as
// "Run agentic review" in pull-review-crush.yml (read the comment at the top
// of its script; apply a fix in one of the two to the other too). Here the
// writable paths are the crush data dir, the build repo's `.crush`,
// `.git/objects` and `.git/code-review`, and the review output dir. The
// sources, the context files and the workspace are read-only. This is the
// only step with secrets: crush reads the key of its provider from the env.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { env, fail, logUntrusted, runnerAgentDirs, sandboxOptions, warning } from './lib.mjs'

const HOME = env('HOME')
const BUILD_REPO = env('BUILD_REPO')
const RESULT_DIR = env('RESULT_DIR')
const CRUSH_LOG_DIR = env('CRUSH_LOG_DIR')
const REVIEW_OUTPUT_FILE = env('REVIEW_OUTPUT_FILE')
const reviewOutputDir = path.dirname(REVIEW_OUTPUT_FILE)
const crushDataDir = path.join(HOME, '.local/share/crush')

// bwrap needs every bind source to exist. The output dir starts empty and no
// saved review is left, so that only this run's review can be picked up.
for (const dir of [crushDataDir, `${BUILD_REPO}/.crush`, `${BUILD_REPO}/.git/code-review`, CRUSH_LOG_DIR]) {
  fs.mkdirSync(dir, { recursive: true })
}
fs.rmSync(reviewOutputDir, { recursive: true, force: true })
fs.rmSync(path.join(RESULT_DIR, 'REVIEW.md'), { force: true })
fs.mkdirSync(reviewOutputDir, { recursive: true })

const agentDirs = runnerAgentDirs()
if (agentDirs.length === 0) {
  console.log('No runner agent install dir found to mask (expected on JIT-configured runners)')
}
const sandbox = [
  ...sandboxOptions({ network: true }),
  ...[crushDataDir, `${BUILD_REPO}/.crush`, `${BUILD_REPO}/.git/objects`, `${BUILD_REPO}/.git/code-review`, reviewOutputDir]
    .flatMap(dir => ['--bind', dir, dir]),
  '--clearenv',
  '--setenv', 'PATH', env('PATH'),
  '--setenv', 'HOME', HOME,
  '--setenv', 'TERM', 'dumb',
  '--setenv', 'NODE_OPTIONS', env('NODE_OPTIONS'),
  '--setenv', 'OPENROUTER_API_KEY', env('OPENROUTER_API_KEY'),
  '--setenv', 'ZAI_API_KEY', env('ZAI_API_KEY'),
  '--setenv', 'KIMI_API_KEY', env('KIMI_API_KEY'),
  '--'
]

const preflight = spawnSync('bwrap', [
  ...sandbox,
  'node', path.join(import.meta.dirname, 'check-sandbox.mjs'),
  '--repo', env('GITHUB_WORKSPACE'),
  '--repo', path.resolve(import.meta.dirname, '../..'),
  ...agentDirs.flatMap(dir => ['--masked', dir])
], { cwd: BUILD_REPO, stdio: 'inherit' })
if (preflight.status !== 0) {
  fail('Sandbox pre-flight failed — refusing to run the review unsandboxed')
}

const crushOut = path.join(CRUSH_LOG_DIR, 'stdout.txt')
const crushErr = path.join(CRUSH_LOG_DIR, 'stderr.txt')
const stdio = [
  fs.openSync(path.join(RESULT_DIR, 'prompt.txt'), 'r'),
  fs.openSync(crushOut, 'w'),
  fs.openSync(crushErr, 'w')
]
const crush = spawnSync('bwrap', [
  ...sandbox,
  'crush', 'run', '-q', '-m', env('CRUSH_MODEL'), '--small-model', env('SMALL_MODEL')
], { cwd: BUILD_REPO, stdio })
stdio.forEach(fd => fs.closeSync(fd))
// As Bash reports them: 128 + the number of a signal, 127 when bwrap is missing.
const crushStatus = crush.error ? 127 : crush.status ?? 128 + os.constants.signals[crush.signal]
fs.writeFileSync(path.join(RESULT_DIR, 'crush-status.txt'), `${crushStatus}\n`)

logUntrusted('crush output (stdout)', crushOut)
logUntrusted('crush stderr', crushErr)
if (crushStatus !== 0) {
  warning(`crush exited with code ${crushStatus}`)
}

// The sandboxed agent wrote the review file: accept only a regular file,
// never a symlink. bwrap's PID namespace ends every sandbox process when crush
// exits, so the file cannot change after this check. crush stdout is not a
// substitute: it is not the review.
const review = fs.lstatSync(REVIEW_OUTPUT_FILE, { throwIfNoEntry: false })
if (review?.isFile() && review.size > 0) {
  fs.copyFileSync(REVIEW_OUTPUT_FILE, path.join(RESULT_DIR, 'REVIEW.md'))
  console.log(`Review saved (${review.size} bytes)`)
} else {
  warning(`crush wrote no review to ${REVIEW_OUTPUT_FILE}`)
}
