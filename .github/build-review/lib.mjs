// Helpers for the step scripts of .github/workflows/build-review-crush.yml.
// Each script is the `run` of one step. It runs outside the sandboxes and
// reads its settings from the step env.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// spawnSync kills a child that prints more than maxBuffer (1 MiB by default),
// which `git ls-tree -r` of a large repo can.
const MAX_BUFFER = 1 << 30

// The value of the env var `name`, or '' if it is not set.
export function env (name) {
  return process.env[name] ?? ''
}

// Escapes workflow command data as @actions/core does, so that a newline in a
// path cannot start a second command.
function escapeData (text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

function escapeProperty (text) {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C')
}

// Prints an error annotation and ends the step with exit code 1.
export function fail (message, title = '') {
  const properties = title ? ` title=${escapeProperty(title)}` : ''
  console.log(`::error${properties}::${escapeData(message)}`)
  process.exit(1)
}

export function warning (message) {
  console.log(`::warning::${escapeData(message)}`)
}

// Runs a command (no shell) and fails the step unless it exits with 0.
// Returns its stdout if `options.stdio` pipes it.
export function run (command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', maxBuffer: MAX_BUFFER, ...options })
  const name = [command, ...args].join(' ')
  if (result.error) {
    fail(`${name}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    fail(`${name} failed with ${result.signal ?? `exit code ${result.status}`}`)
  }
  return result.stdout
}

// Runs a command and returns its stdout as text. stderr goes to the log.
export function output (command, args, options = {}) {
  return run(command, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...options })
}

// Runs a command with its stdout written to `file`.
export function runToFile (file, command, args, options = {}) {
  const fd = fs.openSync(file, 'w')
  run(command, args, { ...options, stdio: ['ignore', fd, 'inherit'] })
  fs.closeSync(fd)
}

export function setOutput (name, value) {
  fs.appendFileSync(env('GITHUB_OUTPUT'), `${name}=${value}\n`)
}

export function addToSummary (text) {
  fs.appendFileSync(env('GITHUB_STEP_SUMMARY'), text)
}

// The words of a list input, split on spaces, tabs and newlines as Bash
// splits words. Patterns in it are not expanded.
export function words (text) {
  return text.split(/[ \t\n]+/).filter(word => word !== '')
}

// The words as Markdown code, separated by commas.
export function codeList (list) {
  return list.map(word => `\`${word}\``).join(', ')
}

// The text of the template `name` in this dir.
export function readTemplate (name) {
  return fs.readFileSync(path.join(import.meta.dirname, name), 'utf8')
}

// Replaces each @NAME@ in `template` with values.NAME. The values are
// inserted as they are: a value that holds @OTHER@ is not filled in again.
export function fill (template, values) {
  return template.replace(/@([A-Z_]+)@/g, (placeholder, key) => {
    if (!Object.hasOwn(values, key)) {
      fail(`A template has the unknown placeholder ${placeholder}`)
    }
    return values[key]
  })
}

// The runner agent install dirs, which hold the runner credentials. This is
// best effort: the paths of the GitHub-hosted runners. A JIT-configured runner
// has none of them.
export function runnerAgentDirs () {
  const dirs = ['/home/runner/actions-runner']
  try {
    const names = fs.readdirSync('/home/runner/runners').filter(name => !name.startsWith('.'))
    dirs.push(...names.sort().map(name => `/home/runner/runners/${name}`))
  } catch {}
  return dirs.filter(dir => fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())
}

// The bwrap options of both sandboxes ("Build both tags" and "Run build
// review"): all namespaces unshared, the whole file system read-only, and
// tmpfs dirs over /tmp, over /run (the runner user is in the docker group,
// and a read-only mount does not stop a connection to /run/docker.sock, which
// gives root), over the runner temp dir and over the runner agent dirs.
export function sandboxOptions ({ network }) {
  const options = ['--unshare-all']
  if (network) {
    options.push('--share-net')
  }
  options.push(
    '--die-with-parent',
    '--ro-bind', '/', '/',
    '--dev', '/dev', '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--tmpfs', '/run',
    '--tmpfs', env('RUNNER_TEMP')
  )
  if (network) {
    // DNS: on Ubuntu /etc/resolv.conf links to the systemd-resolved stub file
    // in /run. Bind that one file back, read-only.
    const resolvConf = fs.realpathSync('/etc/resolv.conf')
    if (resolvConf.startsWith('/run/')) {
      options.push('--ro-bind', resolvConf, resolvConf)
    }
  }
  for (const dir of runnerAgentDirs()) {
    options.push('--tmpfs', dir)
  }
  return options
}

// Prints the untrusted file `file` in a log group. Workflow commands stop
// while it is printed, so a line such as `::error::` in it does nothing. The
// runner sees the resume token only at the start of a line, and the file may
// not end with a newline.
export function logUntrusted (title, file) {
  const token = crypto.randomBytes(16).toString('hex')
  process.stdout.write(`::group::${title}\n::stop-commands::${token}\n`)
  process.stdout.write(fs.readFileSync(file))
  process.stdout.write(`\n::${token}::\n::endgroup::\n`)
}
