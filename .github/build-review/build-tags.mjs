// Step "Build both tags" of build-review-crush.yml: builds the base tag and
// the tag under audit, each in its own source dir.
//
// The build runs code of the tag under audit (its build scripts and its
// dependencies), which is the code that this audit suspects. Outside a
// sandbox, that code could write GITHUB_ENV or GITHUB_PATH, leave a process
// that outlives the step, or use sudo, and so read the API keys of "Run build
// review" or change its verdict. The install can run such code too: a config
// file of the tag can turn on install scripts, e.g. `allowScripts` in
// deno.json. So the install command and the build command both run in bwrap,
// which gives each of them:
//   - no network for the build. The install has network, because it
//     downloads the dependencies;
//   - from the step env only PATH, NODE_OPTIONS and the CA settings of
//     fix-ubuntu-ca-roots (no GITHUB_ENV, GITHUB_PATH or token);
//   - its own PID namespace, so all of its processes end with it;
//   - no_new_privs (bwrap always sets it), so no sudo;
//   - write access only to its source dir, to a HOME dir of the tag (for the
//     caches of the tools) and to tmpfs dirs. The install and the build of a
//     tag share these dirs;
//   - the tmpfs dirs of sandboxOptions() in lib.mjs.
// No later step runs code from the source dirs; they only read files there
// ("Run build review" reads them inside its own sandbox).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { env, fail, run, sandboxOptions, words } from './lib.mjs'

const OUTPUT_DIR = env('OUTPUT_DIR')
const WORK_DIR = env('WORK_DIR')

// OUTPUT_DIR is a path in the source dirs and an `rm -rf` target, so accept
// only the name of a top-level dir.
if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(OUTPUT_DIR)) {
  fail('output-dir must be the name of a top-level dir')
}

const sandboxEnv = [
  '--clearenv',
  '--setenv', 'PATH', env('PATH'),
  '--setenv', 'NODE_OPTIONS', env('NODE_OPTIONS')
]
// fix-ubuntu-ca-roots sets these for Deno and other tools that read them (see
// its action.yml).
for (const name of ['DENO_TLS_CA_STORE', 'SSL_CERT_FILE']) {
  if (env(name)) {
    sandboxEnv.push('--setenv', name, env(name))
  }
}
const installSandbox = [...sandboxOptions({ network: true }), ...sandboxEnv]
const buildSandbox = [...sandboxOptions({ network: false }), ...sandboxEnv]

// The install dirs are names, as `diff -x` reads them: a dir with such a name
// is left out at any depth.
const diffExcludes = words(env('INSTALL_DIRS')).flatMap(name => ['-x', name])

// Extracts the files of `tag` into `dir`.
function extractTag (tag, dir) {
  const archive = `${dir}.tar`
  run('git', ['archive', '--format=tar', `--output=${archive}`, `refs/tags/${tag}`])
  fs.mkdirSync(dir, { recursive: true })
  run('tar', ['-x', '-f', archive, '-C', dir])
  fs.rmSync(archive)
}

// Runs the shell command `command` of the caller in the sandbox `sandbox`. With
// -e and pipefail, a failed part of a command list or pipeline fails the step.
function runInSandbox (sandbox, writable, command, what) {
  const shell = ['bash', '-e', '-o', 'pipefail', '-c', command]
  const result = spawnSync('bwrap', [...sandbox, ...writable, '--', ...shell], {
    stdio: 'inherit'
  })
  if (result.status !== 0) {
    fail(`${what} failed with ${result.error?.message ?? result.signal ?? `exit code ${result.status}`}`)
  }
}

function buildTag (tag, dir, home) {
  const writable = [
    '--bind', dir, dir,
    '--bind', home, home,
    '--setenv', 'HOME', home,
    '--chdir', dir
  ]
  console.log(`::group::Build ${tag}`)
  fs.mkdirSync(home, { recursive: true })
  extractTag(tag, dir)
  // Old tags can have the output dir in git, and their build may not delete
  // it first, so files of deleted sources would stay.
  fs.rmSync(path.join(dir, OUTPUT_DIR), { recursive: true, force: true })
  runInSandbox(installSandbox, writable, env('INSTALL_COMMAND'), `The install of ${tag}`)
  runInSandbox(buildSandbox, writable, env('BUILD_COMMAND'), `The build of ${tag}`)

  // A package can ship root files, such as package.json, as the build leaves
  // them, but the audit reads only the output dir. A normal build changes no
  // file outside the output dir and the install dirs, so fail on any other
  // change. The sandbox has ended all build processes by now. The output dir
  // is moved out for the diff, because `diff -x` would also leave out a
  // nested dir with its name, such as src/build/.
  const pristine = fs.mkdtempSync(path.join(os.tmpdir(), 'pristine-'))
  extractTag(tag, pristine)
  fs.rmSync(path.join(pristine, OUTPUT_DIR), { recursive: true, force: true })
  const output = path.join(dir, OUTPUT_DIR)
  const movedOutput = `${dir}.${OUTPUT_DIR}`
  const hasOutput = fs.lstatSync(output, { throwIfNoEntry: false }) !== undefined
  if (hasOutput) {
    fs.renameSync(output, movedOutput)
  }
  const diff = spawnSync('diff', ['-ru', '--no-dereference', ...diffExcludes, pristine, dir], {
    stdio: 'inherit'
  })
  if (diff.status !== 0) {
    fail(`The build of ${tag} changed files outside ${OUTPUT_DIR}/ and the install dirs (diff in the log of this step)`)
  }
  if (hasOutput) {
    fs.renameSync(movedOutput, output)
  }
  fs.rmSync(pristine, { recursive: true })
  console.log('::endgroup::')
}

buildTag(env('BASE_TAG'), `${WORK_DIR}/base-src`, `${WORK_DIR}/base-home`)
buildTag(env('TAG'), `${WORK_DIR}/release-src`, `${WORK_DIR}/release-home`)
