/* eslint-disable no-console */
import fs from 'fs'
import { tmpdir } from 'os'
import { resolve, extname, dirname as pathDirname } from 'path'
import { build } from 'esbuild'
import sourceMapSupport from 'source-map-support'
import importPlugin from 'esbuild-dynamic-import-plugin'
import InternalModule from "module"
import { fileURLToPath } from 'url';
import babel from 'esbuild-plugin-babel';

export function dirname(importMeta) {
    return pathDirname(filename(importMeta));
}

export function filename(importMeta) {
    return importMeta.url ? fileURLToPath(importMeta.url) : '';
}


const logLevel = process.env.TS_EAGER_LOGLEVEL || 'error' // 'warning', 'info', 'silent'

const tsconfigName = process.env.TS_NODE_PROJECT || undefined
const ignoreRegexes = process.env.TS_NODE_IGNORE || '(?:^|/)node_modules/'

const ignores = ignoreRegexes.split(/ *, */g).map((str) => new RegExp(str))

let tsconfig = ''
let basePath = process.cwd()
let files = []
let allowJs = false
let emitDecoratorMetadata = false
let compilerOptions
try {
  const { sys, findConfigFile, readConfigFile, parseJsonConfigFileContent } = await import('typescript')

  tsconfig = findConfigFile('.', sys.fileExists, tsconfigName) || 'tsconfig.json'
  const parsedConfig = parseJsonConfigFileContent(readConfigFile(tsconfig, sys.readFile).config, sys, '.')

  basePath = pathDirname(tsconfig)
  files = parsedConfig.fileNames
  allowJs = !!parsedConfig.options.allowJs
  emitDecoratorMetadata = !!parsedConfig.options.emitDecoratorMetadata

  compilerOptions = parsedConfig.raw.compilerOptions

  const { baseUrl, paths } = parsedConfig.options
  if (Object.keys(paths || {}).length) {
    try {
      await import('tsconfig-paths').register({ baseUrl, paths })
    } catch (e) {
      if (['warning', 'info'].includes(logLevel)) {
        console.error('tsconfig has paths, but tsconfig-paths is not installed')
        console.error('Proceeding without paths support...')
      }
    }
  }
} catch (e) {
  if (['warning', 'info'].includes(logLevel)) {
    console.error(`Could not parse ${tsconfigName || 'tsconfig.json'} (is typescript installed?)`)
    console.error(e)
    console.error('Proceeding without eager compilation...')
  }
}

files = files.filter((file) => !file.endsWith('.d.ts')).map((path) => resolve(basePath, path))

if (logLevel == 'info') {
  console.log('Eagerly compiling:', files)
}

// const tmpPath = resolve(tmpdir())
const tmpPath = resolve(tmpdir(), "xrengine-gameserver")
if (fs.existsSync(tmpPath)) {
  fs.rmdirSync(tmpPath, { recursive: true })
}
fs.mkdirSync(tmpPath)
console.log(tmpPath)

const extensions = (allowJs ? ['.js', '.jsx'] : []).concat(['.ts', '.tsx'])

const defaultEsbuildOptions = {
  plugins: [
    // look into this https://github.com/netlify/zip-it-and-ship-it/blob/main/src/runtimes/node/dynamic_imports/plugin.js
    // {
    //   name: 'resolve-require',
    //   build() {

    //   }
    // }
    // importPlugin()
  ],
  tsconfig: tsconfig || undefined,
  target: 'node' + process.versions.node.split('.')[0],
  // target: '',
  format: 'esm',
  splitting: true,
  sourcemap: 'inline',
  platform: 'node',
  write: false,
  logLevel,
  external: ['pg-hstore'],
  bundle: true,
  minify: true,
  outdir: tmpPath
}

// The default esbuild buffer size seems to be too small for medium-sized projects
// and node will throw ENOBUFS errors, so we increase it here to 256MB if not already set
// https://github.com/evanw/esbuild/blob/6be0962826a97dd49f6e1f4f93277442783d5257/lib/npm/node.ts#L347
if (process.env.ESBUILD_MAX_BUFFER == null) {
  process.env.ESBUILD_MAX_BUFFER = 256 * 1024 * 1024
}

const entryPoint = 'src/index.ts'

const { warnings, outputFiles } = await build({
  ...defaultEsbuildOptions,
  entryPoints: [entryPoint],
})
console.log(outputFiles.length)
outputFiles.map((file) => {
  fs.writeFileSync(file.path, file.contents, { encoding: "utf-8" })
})
const code = fs.readFileSync(outputFiles[0].path, 'utf-8')
// console.log(code)
for (const warning of warnings) {
  console.error(warning.location)
  console.error(warning.text)
}

const fileContents = (outputFiles || []).reduce((map, { contents }, ix) => map.set(files[ix], contents), new Map())

const decoder = new TextDecoder('utf-8')

const retrieveFile = (path) => {
  let js = fileContents.get(path)
  if (js != null && typeof js !== 'string') {
    js = decoder.decode(js)
    fileContents.set(path, js)
  }
  return js
}

let tsNodeService

const compile = async (code, filename) => {
  console.log('compile', code, filename)
  if (!fileContents.has(filename)) {
    const { warnings, outputFiles } = await build({
      ...defaultEsbuildOptions,
      stdin: {
        loader: extname(filename).slice(1),
        sourcefile: filename,
        contents: code,
      },
    })
    for (const warning of warnings) {
      console.error(warning.location)
      console.error(warning.text)
    }
    fs.writeFileSync(outputFiles[0].path, outputFiles[0].contents, { encoding: "utf-8" })
    const { contents } = (outputFiles || [])[0] || {}
    if (contents != null) {
      fileContents.set(filename, contents)
    }
  }
  if (emitDecoratorMetadata) {
    const js = retrieveFile(filename)
    if (/^var __decorate(Class|Param)? = /m.test(js) && !/^var __metadata = /m.test(js)) {
      if (tsNodeService == null) {
        const { create } = await import('ts-node')
        tsNodeService = create({ transpileOnly: true, compilerOptions, skipProject: !!compilerOptions })
      }
      fileContents.set(filename, tsNodeService.compile(code, filename))
    }
  }
  return retrieveFile(filename)
}

let requireExtensions
try {
  requireExtensions = InternalModule._extensions
} catch (e) {
  console.error('Could not register extension')
  throw e
}

const shouldIgnore = (relname) => {
  const path = relname.replace(/\\/g, '/')
  return ignores.some((x) => x.test(path))
}

const origJsHandler = requireExtensions['.js']

const registerExtension = (ext, compile) => {
  const origHandler = requireExtensions[ext] || origJsHandler
  requireExtensions[ext] = function (module, filename) {
    if (shouldIgnore(filename)) {
      return origHandler(module, filename)
    }
    const code = fs.readFileSync(filename, 'utf8')
    return module._compile(compile(code, filename), filename)
  }
}

sourceMapSupport.install({ retrieveFile, environment: 'node', handleUncaughtExceptions: false })

extensions.forEach((ext) => registerExtension(ext, compile))

const newPath = resolve(tmpPath, "index.js")
console.log(newPath)

fs.writeFileSync(tmpPath + "/package.json", `
{
  "name": "gameserver-tmp-shim",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}`);

// fs.readdir(tmpPath, function (err, files) {
//   if (err) {
//     return console.log('Unable to scan directory: ' + err)
//   } 
//   files.forEach(function (file) {
//     console.log(file)
//   })
// })


import(newPath)