// The public app's build number, which App Store Connect needs to rise with every upload
// and which the app and its widget must share. It is the UTC minute of the build, so it
// needs no counter to keep and rises by itself on any machine. `npm run build:public`
// runs this last, so a new web bundle always gets a new number. It writes
// ios/BuildNumber.xcconfig, which is not committed: ios/PublicApp.xcconfig includes it,
// and both targets read it from there, from Xcode or the command line.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The minute `now` as a number: 2026-11-05 20:49 UTC is 202611052049. */
export function minuteStamp(now) {
  return Number(now.toISOString().slice(0, 16).replace(/\D/g, ''))
}

/** Never the last number again, and never less: a clock set back must not undo it. */
export function nextBuildNumber(previous, now) {
  const stamp = minuteStamp(now)
  return previous >= stamp ? previous + 1 : stamp
}

/** The number in a file this script wrote, or 0 for none. */
export function readBuildNumber(text) {
  return Number(text.match(/^CURRENT_PROJECT_VERSION\s*=\s*(\d+)\s*$/m)?.[1] ?? 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
  const file = resolve(root, 'ios/BuildNumber.xcconfig')
  const previous = existsSync(file) ? readBuildNumber(readFileSync(file, 'utf8')) : 0
  const number = nextBuildNumber(previous, new Date())
  writeFileSync(file, `// Written by scripts/build-number.mjs. Not committed.\nCURRENT_PROJECT_VERSION = ${number}\n`)
  console.log(`build-number: ${number}`)
}
