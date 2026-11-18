// Step "Check verdict" of build-review-crush.yml. Fails closed: the audit
// passes only with a complete review whose last line is the CLEAN verdict and
// that lists no finding. Also puts the review in the job summary.
import fs from 'node:fs'
import path from 'node:path'
import { addToSummary, env, fail } from './lib.mjs'

const TAG = env('TAG')
const RESULT_DIR = env('RESULT_DIR')

function readText (file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

const review = readText(path.join(RESULT_DIR, 'REVIEW.md'))

addToSummary(`## Build review of \`${TAG}\` against \`${env('BASE_TAG')}\`\n\n${
  review || '_crush wrote no review. Read the "Run build review" step log._\n'
}`)

function failAudit (reason) {
  fail(`${reason}. Read the job summary.`, `Build review of ${TAG} failed`)
}

const crushStatus = readText(path.join(RESULT_DIR, 'crush-status.txt')).trim()
if (crushStatus !== '0') {
  failAudit(`crush exited with code ${crushStatus}`)
}
if (!review) {
  failAudit('crush wrote no review')
}
// The checks read lines as grep does: [ \t\v\f\r] is [[:space:]] without the
// newline, so that no match spans two lines.
if (/^#{1,6}[ \t\v\f\r]*Unreviewed files/im.test(review)) {
  failAudit('Part of the build diff was not reviewed')
}
// The last non-blank line, without backticks, bold marks and surrounding
// space, which models add although the rules ask for plain text.
const lastLine = review.split('\n').filter(line => !/^[ \t\v\f\r]*$/.test(line)).at(-1) ?? ''
const verdict = lastLine.replace(/[`*\r]/g, '').replace(/^[ \t\v\f]+|[ \t\v\f]+$/g, '')
if (verdict === 'BUILD-REVIEW-VERDICT: CLEAN') {
  // The code-review skill gives each finding a "## <N>. <severity> <title>"
  // heading (audit rule 4).
  if (/^#{1,6}[ \t\v\f\r]*[0-9]+\.[ \t\v\f\r]/m.test(review)) {
    failAudit('The review says CLEAN but lists findings')
  }
  console.log(`The audit found no suspect code in the build of ${TAG}`)
} else if (verdict === 'BUILD-REVIEW-VERDICT: SUSPICIOUS') {
  failAudit(`The audit found suspect code in the build of ${TAG}`)
} else {
  failAudit('The review has no verdict line')
}
