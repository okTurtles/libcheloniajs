// Step "Build review prompt" of build-review-crush.yml: writes the crush
// prompt, review-prompt.md with the audit rules of "Write audit context".
import fs from 'node:fs'
import path from 'node:path'
import { env, fill, readTemplate } from './lib.mjs'

const RESULT_DIR = env('RESULT_DIR')
const rules = fs.readFileSync(path.join(env('CONTEXT_DIR'), 'audit-rules.md'), 'utf8')
const prompt = fill(readTemplate('review-prompt.md'), {
  PROJECT_CONTEXT: env('PROJECT_CTX') || 'You are auditing a release of an npm package.',
  REVIEW_OUTPUT_FILE: env('REVIEW_OUTPUT_FILE'),
  REVIEW_MODEL: env('REVIEW_MODEL'),
  // The template ends the prompt with a newline.
  AUDIT_RULES: rules.replace(/\n$/, '')
})
fs.mkdirSync(RESULT_DIR, { recursive: true })
fs.writeFileSync(path.join(RESULT_DIR, 'prompt.txt'), prompt)

console.log('::group::Review prompt')
process.stdout.write(prompt)
console.log('::endgroup::')
