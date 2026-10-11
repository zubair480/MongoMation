// Build an OpenPLC Runtime v4 (>= v4.1, STruC++ pipeline) upload bundle from a
// single .st file, mirroring openplc-editor's compose-runtime-v4-bundle.ts +
// program-build-pipeline.ts (monolithic, no per-POU split).
//
// usage: node build_v4_bundle.mjs <program.st> <outDir> [modbus_master.json] [modbus_slave.json]
//   writes <outDir>/bundle/... and <outDir>/program.zip
// exit codes: 0 ok, 2 usage, 4 STruC++ compile error
// env: STRUCPP_DIR = path to an installed strucpp package (node_modules/strucpp)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const STRUCPP_DIR =
  process.env.STRUCPP_DIR ||
  (process.env.HOME + '/mm-tools/refs/strucpp-run/node_modules/strucpp')

const [stPath, outDirArg, masterJson, slaveJson] = process.argv.slice(2)
if (!stPath || !outDirArg) {
  console.error('usage: node build_v4_bundle.mjs <program.st> <outDir> [modbus_master.json] [modbus_slave.json]')
  process.exit(2)
}

const sc = await import(pathToFileURL(join(STRUCPP_DIR, 'dist/node/index.js')).href)
console.error(`[strucpp] version ${sc.getVersion()} from ${STRUCPP_DIR}`)

const source = readFileSync(stPath, 'utf8')
const md5 = createHash('md5').update(source).digest('hex')

// The editor feeds every bundled .stlib (iec-standard-fb, iec-std-functions,
// additional-function-blocks, oscat-basic, plcopen-softmotion), sorted by file name.
const libsDir = join(STRUCPP_DIR, 'libs')
const libraries = readdirSync(libsDir)
  .filter((f) => f.endsWith('.stlib'))
  .sort()
  .map((f) => sc.loadStlibFromFile(join(libsDir, f)))

const result = sc.compile(source, {
  headerFileName: 'generated.hpp',
  fileName: 'program.st',
  debug: true,
  lineMapping: true,
  libraries,
  md5,
  pouIncludes: [],
})

const sm = sc.buildSourceMap([{ fileName: 'program.st', source }])
for (const w of result.warnings ?? []) console.error(sc.formatDiagnostic(w, sm))
if (!result.success) {
  for (const e of result.errors) console.error(sc.formatDiagnostic(e, sm))
  console.error(`[strucpp] FAILED with ${result.errors.length} error(s)`)
  process.exit(4)
}

const outDir = resolve(outDirArg)
const bundleDir = join(outDir, 'bundle')
rmSync(bundleDir, { recursive: true, force: true })
mkdirSync(join(bundleDir, 'strucpp_runtime', 'include'), { recursive: true })

const files = {}
files['program.st'] = source
if (result.cppFiles && result.cppFiles.length > 0) {
  for (const f of result.cppFiles) files[f.name] = f.content
} else {
  files['generated.cpp'] = result.cppCode
}
files['generated.hpp'] = result.headerCode
if (result.debugTableCpp !== undefined) files['generated_debug.cpp'] = result.debugTableCpp
if (result.debugMap !== undefined) files['debug-map.json'] = JSON.stringify(result.debugMap, null, 2)
files['defines.h'] = `#pragma once\n// Program MD5\n#define PROGRAM_MD5 "${md5}"\n`
files['c_blocks.h'] = '// Empty file\n'
if (masterJson) files['conf/modbus_master.json'] = readFileSync(masterJson, 'utf8')
if (slaveJson) files['conf/modbus_slave.json'] = readFileSync(slaveJson, 'utf8')

for (const [name, content] of Object.entries(files)) {
  const p = join(bundleDir, name)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}
const incDir = join(STRUCPP_DIR, 'src', 'runtime', 'include')
for (const f of readdirSync(incDir)) {
  copyFileSync(join(incDir, f), join(bundleDir, 'strucpp_runtime', 'include', f))
}

// Zip with entries at the archive root (runtime extracts into core/generated/).
const zipPath = join(outDir, 'program.zip')
if (existsSync(zipPath)) rmSync(zipPath)
execFileSync('python3', ['-I', '-c',
  'import os,sys,zipfile\n' +
  'root,dst=sys.argv[1],sys.argv[2]\n' +
  'with zipfile.ZipFile(dst,"w",zipfile.ZIP_DEFLATED) as z:\n' +
  '  for d,_,fs in os.walk(root):\n' +
  '    for f in sorted(fs):\n' +
  '      p=os.path.join(d,f); z.write(p, os.path.relpath(p,root).replace(os.sep,"/"))\n',
  bundleDir, zipPath])

console.error(`[strucpp] OK md5=${md5} files=${Object.keys(files).length} + ${readdirSync(incDir).length} runtime headers`)
console.log(JSON.stringify({ ok: true, md5, zip: zipPath, files: Object.keys(files) }))
