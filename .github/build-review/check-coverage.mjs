// Step "Check review coverage" of build-review-crush.yml. The code-review
// skill leaves some paths out of its diff (DEFAULT_EXCLUDES in its
// scripts/lib/git.mjs: dist/, build/, node_modules/, vendor/, *.min.js, *.map,
// lock files, images, fonts) and shows a binary file as a change of 0 lines.
// Code that the build put in such a file would never be audited, so fail when
// the skill's own `prep` drops a changed file or sees one as binary.
import path from 'node:path'
import { env, fail, output, run } from './lib.mjs'

const options = { cwd: env('BUILD_REPO'), env: { ...process.env, LC_ALL: 'C' } }
const reviewScript = path.join(env('HOME'), '.config/crush/skills/code-review/scripts/review.mjs')
const prep = JSON.parse(output('node', [reviewScript, 'prep', '--base', 'base-build'], options))
run('node', [reviewScript, 'clean', '--run-dir', String(prep.runDir)], {
  ...options, stdio: ['ignore', 'ignore', 'inherit']
})

// --no-renames lists both paths of a rename. prep pairs them, so compare with
// its new and old paths. A path that git quotes counts as left out, so the
// check fails closed.
const changed = output('git', [
  '-c', 'core.quotePath=false', 'diff', '--no-renames', '--name-only', 'base-build', 'release-build'
], options).split('\n').filter(file => file !== '')
const covered = new Set(prep.files.flatMap(file => {
  return file.oldPath ? [file.path, file.oldPath] : [file.path]
}))
const skipped = [...new Set(changed)].filter(file => !covered.has(file)).sort()
const binary = prep.files.filter(file => file.binary).map(file => file.path)
if (skipped.length > 0 || binary.length > 0) {
  if (skipped.length > 0) {
    console.log(`Left out of the diff:\n${skipped.join('\n')}`)
  }
  if (binary.length > 0) {
    console.log(`Shown as binary:\n${binary.join('\n')}`)
  }
  fail('The code-review skill would not show every changed built file to the auditor')
}
console.log(`The diff of the skill covers all ${prep.files.length} changed files`)
