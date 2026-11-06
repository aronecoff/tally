// The checks on what would go to App Store Connect, run over a Release .app or an
// .xcarchive. `npm run archive:public` runs it. It looks for what an upload is refused
// for, the way the upload does: the required-reason APIs each binary actually imports,
// against what its privacy manifest says. Xcode's privacy report only reads the manifests.
//
// Both directions are checked. An API with no reason is refused, and a reason with no API
// is a line in the manifest that nothing stands behind.
//
// The list is Apple's, from the NSPrivacyAccessedAPIType page (read 2026-11-05). It changes
// from time to time. clock_gettime is deliberately absent: it is not on it, and the lock's
// clock uses it, not mach_absolute_time or systemUptime.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const REQUIRED_REASON = [
  {
    category: 'NSPrivacyAccessedAPICategoryUserDefaults',
    reasons: { 'CA92.1': 'the app\'s own defaults', '1C8F.1': 'an App Group\'s defaults' },
    symbols: [/^_OBJC_CLASS_\$_NSUserDefaults$/],
    selectors: [],
    // A suite is a group, and standardUserDefaults is the app's own.
    reasonFor: ({ selectors }) => [
      ...(selectors.has('standardUserDefaults') ? ['CA92.1'] : []),
      ...(selectors.has('initWithSuiteName:') ? ['1C8F.1'] : []),
    ],
  },
  {
    category: 'NSPrivacyAccessedAPICategoryFileTimestamp',
    reasons: { 'C617.1': 'files in the app or group container' },
    symbols: [
      /^_(stat|fstat|fstatat|lstat)(\$INODE64)?$/, /^_(f?getattrlist|getattrlistat|getattrlistbulk)$/,
      /^_NSFile(Creation|Modification)Date$/, /^_NSURL(ContentModification|Creation)DateKey$/,
      /URLResourceValuesV.*(creationDate|contentModificationDate)/,
    ],
    selectors: ['fileModificationDate', 'fileCreationDate'],
    reasonFor: () => ['C617.1'],
  },
  {
    category: 'NSPrivacyAccessedAPICategorySystemBootTime',
    reasons: { '35F9.1': 'time between events in the app' },
    symbols: [/^_mach_absolute_time$/],
    selectors: ['systemUptime'],
    reasonFor: () => ['35F9.1'],
  },
  {
    category: 'NSPrivacyAccessedAPICategoryDiskSpace',
    reasons: { 'E174.1': 'room to write files' },
    symbols: [
      /^_f?statv?fs(\$INODE64)?$/, /^_NSFileSystem(Free)?Size$/, /^_NSURLVolume(AvailableCapacity|TotalCapacity)/,
      /URLResourceValuesV.*volume(Available|Total)Capacity/,
    ],
    selectors: [],
    reasonFor: () => ['E174.1'],
  },
  {
    category: 'NSPrivacyAccessedAPICategoryActiveKeyboards',
    reasons: { '54BD.1': 'a keyboard-specific interface' },
    symbols: [],
    selectors: ['activeInputModes'],
    reasonFor: () => ['54BD.1'],
  },
]

/** Debug switches that must not reach a store build. */
const DEBUG_ONLY = ['PLAINSUM_NO_NETWORK']

const run = (tool, ...args) => execFileSync(tool, args, { encoding: 'utf8', maxBuffer: 1 << 28 })
const plist = (file) => JSON.parse(run('plutil', '-convert', 'json', '-o', '-', file))

/** What a binary reaches for, as an upload's scan sees it. */
function imports(binary) {
  return {
    symbols: run('xcrun', 'nm', '-u', binary).split('\n').map((s) => s.trim()).filter(Boolean),
    strings: run('strings', '-a', binary).split('\n'),
  }
}

function checkBundle(bundle, hits) {
  const name = basename(bundle)
  const info = plist(join(bundle, 'Info.plist'))
  const binary = join(bundle, info.CFBundleExecutable)
  const manifestFile = join(bundle, 'PrivacyInfo.xcprivacy')
  if (!existsSync(manifestFile)) {
    hits.push(`${name}: no PrivacyInfo.xcprivacy`)
    return info
  }
  const manifest = plist(manifestFile)
  if (manifest.NSPrivacyTracking !== false) hits.push(`${name}: NSPrivacyTracking is not false`)
  if (manifest.NSPrivacyTrackingDomains?.length) hits.push(`${name}: it lists tracking domains`)
  if (manifest.NSPrivacyCollectedDataTypes?.length) hits.push(`${name}: it lists collected data types`)

  const { symbols, strings } = imports(binary)
  const selectors = new Set(strings)
  const declared = new Map((manifest.NSPrivacyAccessedAPITypes ?? []).map((t) => [t.NSPrivacyAccessedAPIType, t.NSPrivacyAccessedAPITypeReasons ?? []]))

  for (const api of REQUIRED_REASON) {
    const found = [
      ...symbols.filter((s) => api.symbols.some((re) => re.test(s))),
      ...api.selectors.filter((s) => selectors.has(s)),
    ]
    const reasons = declared.get(api.category)
    if (found.length === 0) {
      if (reasons) hits.push(`${name}: ${api.category} is declared and the binary does not use it`)
      continue
    }
    if (!reasons) {
      hits.push(`${name}: uses ${found.join(', ')} with no ${api.category} in its manifest`)
      continue
    }
    for (const needed of api.reasonFor({ selectors })) {
      if (!reasons.includes(needed)) hits.push(`${name}: ${api.category} needs ${needed} (${api.reasons[needed]})`)
    }
    for (const reason of reasons) {
      if (!api.reasonFor({ selectors }).includes(reason)) hits.push(`${name}: ${api.category} declares ${reason}, which this binary has no use for`)
    }
    console.log(`  ${name}: ${api.category.replace('NSPrivacyAccessedAPICategory', '')} ${reasons.join(', ')} (${found.join(', ')})`)
  }
  for (const category of declared.keys()) {
    if (!REQUIRED_REASON.some((api) => api.category === category)) hits.push(`${name}: ${category} is not a category this check knows`)
  }
  for (const flag of DEBUG_ONLY) if (selectors.has(flag)) hits.push(`${name}: ${flag} is in the binary. Is this a Debug build?`)
  return info
}

function findApp(path) {
  if (path.endsWith('.app')) return path
  const apps = join(path, 'Products/Applications')
  const found = existsSync(apps) ? readdirSync(apps).filter((f) => f.endsWith('.app')) : []
  if (found.length !== 1) {
    console.error(`verify-store-build: no single app in ${apps}`)
    process.exit(1)
  }
  return join(apps, found[0])
}

const target = process.argv[2]
if (!target || !existsSync(target)) {
  console.error('usage: node scripts/verify-store-build.mjs <Plainsum.app or .xcarchive>')
  process.exit(1)
}
const path = resolve(target)
const app = findApp(path)
const hits = []

const appInfo = checkBundle(app, hits)
const plugins = join(app, 'PlugIns')
const extensions = existsSync(plugins) ? readdirSync(plugins).filter((f) => f.endsWith('.appex')) : []
if (extensions.length === 0) hits.push('the app has no widget extension')
for (const appex of extensions) {
  const info = checkBundle(join(plugins, appex), hits)
  for (const key of ['CFBundleVersion', 'CFBundleShortVersionString']) {
    if (info[key] !== appInfo[key]) hits.push(`${appex}: ${key} is ${info[key]} and the app's is ${appInfo[key]}`)
  }
}

const version = appInfo.CFBundleVersion
// 1 is what the build falls back to with no ios/BuildNumber.xcconfig.
if (!/^[1-9]\d{0,17}$/.test(version) || version === '1') hits.push(`build number ${version}: run npm run build:public first`)
if (JSON.stringify(appInfo.UIDeviceFamily) !== '[1]') hits.push('the app is not iPhone only')
if (path.endsWith('.xcarchive')) {
  // Read on its own: this plist holds a date, which plutil will not turn into JSON.
  const stored = run('plutil', '-extract', 'ApplicationProperties.CFBundleVersion', 'raw', '-o', '-', join(path, 'Info.plist')).trim()
  if (stored !== version) hits.push(`the archive says build ${stored} and the app says ${version}`)
}

if (hits.length) {
  console.error(`verify-store-build: ${hits.length} problem${hits.length === 1 ? '' : 's'}`)
  for (const hit of hits) console.error(`  ${hit}`)
  process.exit(1)
}
console.log(`verify-store-build: ${appInfo.CFBundleDisplayName} ${appInfo.CFBundleShortVersionString} (${version}), ${1 + extensions.length} manifests match their binaries`)
