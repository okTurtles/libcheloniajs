// Step "Assemble build repo" of build-review-crush.yml. The build repo holds
// the two builds as two commits: base-build, and release-build (HEAD) on top
// of it, so the code-review skill's `prep --base base-build` diffs exactly the
// two builds. Sets the step output `changed`: whether the builds differ.
import fs from 'node:fs'
import path from 'node:path'
import { addToSummary, env, fail, output, run, runToFile, setOutput, words } from './lib.mjs'

const TAG = env('TAG')
const BASE_TAG = env('BASE_TAG')
const OUTPUT_DIR = env('OUTPUT_DIR')
const WORK_DIR = env('WORK_DIR')
const BUILD_REPO = env('BUILD_REPO')
const CONTEXT_DIR = env('CONTEXT_DIR')
const EXCLUDED_FILES = words(env('EXCLUDED_FILES'))
const COPIED_FILES = words(env('COPIED_FILES'))
const built = path.join(BUILD_REPO, 'built')

function git (...args) {
  run('git', ['-C', BUILD_REPO, ...args])
}

// The `find` tests `<test> <prefix><pattern>` of the patterns, joined with -o.
function anyOf (test, prefix, patterns) {
  return patterns.flatMap((pattern, index) => [...(index > 0 ? ['-o'] : []), test, prefix + pattern])
}

// All files and dirs under `dir`, without following symlinks.
function * walk (dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    yield { file, entry }
    if (entry.isDirectory()) {
      yield * walk(file)
    }
  }
}

// The ids of the blobs that git tracks at `tag` outside the output dir. Old
// tags can have their output dir in git, so a file there does not count.
// Without -z, git quotes a path with unusual bytes, so an output dir path would
// not start with "<output dir>/". --format quotes %(path) even with -z, so this
// reads the default format: "<mode> <type> <id><TAB><path>".
function trackedBlobsOutsideOutputDir (tag) {
  const ids = new Set()
  for (const entry of output('git', ['ls-tree', '-r', '-z', `refs/tags/${tag}`]).split('\0')) {
    const tab = entry.indexOf('\t')
    if (tab === -1) {
      continue
    }
    const [, type, id] = entry.slice(0, tab).split(' ')
    if (type === 'blob' && !entry.slice(tab + 1).startsWith(`${OUTPUT_DIR}/`)) {
      ids.add(id)
    }
  }
  return ids
}

// Copies the output dir of the source dir `src` to built/ and removes the
// files that the audit leaves out.
function copyBuild (src, tag) {
  const out = path.join(src, OUTPUT_DIR)
  // This copy runs outside the build sandbox. A symlink could make it read a
  // path that the sandbox hides, and a .gitignore or .gitattributes could hide
  // files from the diff or mark them binary. So the audit accepts only regular
  // files and dirs, and no dotfiles.
  if (!fs.lstatSync(out, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`The build in ${src} has no ${OUTPUT_DIR}/ dir, or its ${OUTPUT_DIR}/ is a symlink`)
  }
  const oddFiles = [...walk(out)]
    .filter(({ entry }) => entry.name.startsWith('.') || !(entry.isFile() || entry.isDirectory()))
    .map(({ file }) => file)
  if (oddFiles.length > 0) {
    console.log(oddFiles.join('\n'))
    fail(`The build in ${src} has dotfiles, symlinks or other special files, which the audit does not accept`)
  }
  fs.mkdirSync(built, { recursive: true })
  run('cp', ['-a', `${out}/.`, `${built}/`])

  // A byte copy of a file in git holds nothing that the build added.
  if (COPIED_FILES.length > 0) {
    const tracked = trackedBlobsOutsideOutputDir(tag)
    const copies = output('find', [built, '-type', 'f', '(', ...anyOf('-path', `${built}/`, COPIED_FILES), ')', '-print0'])
      .split('\0')
      .filter(file => file !== '')
    for (const file of copies) {
      const id = output('git', ['hash-object', '--no-filters', '--', file]).trim()
      if (!tracked.has(id)) {
        fail(`${OUTPUT_DIR}/${file.slice(built.length + 1)} of ${tag} matches copied-files, but git tracks no equal file outside ${OUTPUT_DIR}/`)
      }
      fs.rmSync(file)
    }
    console.log(`Left out ${copies.length} files of ${tag} that equal files in git (copied-files)`)
  }
  if (EXCLUDED_FILES.length > 0) {
    run('find', [built, '-type', 'f', '(', ...anyOf('-name', '', EXCLUDED_FILES), ')', '-delete'])
  }
}

run('git', ['init', '-q', '-b', 'base-build', BUILD_REPO])
git('config', 'user.name', 'Build review')
git('config', 'user.email', 'build-review@invalid')
fs.copyFileSync(path.join(CONTEXT_DIR, 'audit-rules.md'), path.join(BUILD_REPO, 'AGENTS.md'))
copyBuild(`${WORK_DIR}/base-src`, BASE_TAG)
// -f: a global git ignore file must not hide a built file.
git('add', '-A', '-f')
git('commit', '-q', '-m', `Build of ${BASE_TAG}`)
git('checkout', '-q', '-b', 'release-build')
fs.rmSync(built, { recursive: true, force: true })
copyBuild(`${WORK_DIR}/release-src`, TAG)
git('add', '-A', '-f')
git('commit', '-q', '--allow-empty', '-m', `Build of ${TAG}`)

const buildDiff = path.join(CONTEXT_DIR, 'build.diff')
runToFile(buildDiff, 'git', ['-C', BUILD_REPO, 'diff', 'base-build', 'release-build'])
if (fs.statSync(buildDiff).size > 0) {
  git('diff', '--shortstat', 'base-build', 'release-build')
  setOutput('changed', 'true')
} else {
  console.log(`No runtime build changes from ${BASE_TAG} to ${TAG}; nothing to review`)
  addToSummary(`No runtime build changes from \`${BASE_TAG}\` to \`${TAG}\`. Nothing to review.\n`)
  setOutput('changed', 'false')
}
