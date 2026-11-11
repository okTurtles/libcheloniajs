// Pre-flight of "Run build review" (see run-review.mjs). Runs inside the
// review sandbox and exits with 1 if the sandbox shows a GitHub token,
// persisted git credentials in one of the --repo checkouts, or runner
// credentials in one of the --masked dirs. It gets the exact paths to probe as
// arguments.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    repo: { type: 'string', multiple: true, default: [] },
    masked: { type: 'string', multiple: true, default: [] }
  }
})

const problems = []
const tokenName = /^(GH_TOKEN|GITHUB_TOKEN|ACTIONS_[A-Z_]*TOKEN)$/
if (Object.keys(process.env).some(name => tokenName.test(name))) {
  problems.push('a GitHub token is visible inside sandbox')
}
for (const repo of values.repo) {
  const config = spawnSync('git', ['-C', repo, 'config', '--get', 'http.https://github.com/.extraheader'], {
    stdio: 'ignore'
  })
  if (config.status === 0) {
    problems.push(`persisted git credentials visible inside sandbox in ${repo}`)
  }
}
for (const dir of values.masked) {
  if (fs.existsSync(`${dir}/.credentials`) || fs.existsSync(`${dir}/.credentials_rsaparams`)) {
    problems.push(`runner credentials visible inside sandbox at ${dir}`)
  }
}
if (problems.length > 0) {
  console.log(problems.join('\n'))
  process.exitCode = 1
}
