#!/usr/bin/env node

import { spawn } from "node:child_process"
import { cp, copyFile, mkdir, readFile, readdir, rename, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { fossilize } from "fossilize"

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const root = path.resolve(dir, "../..")
const staging = path.join(dir, ".fossilize")
const outdir = path.join(dir, "dist/server")
const platform = process.platform === "win32" ? "win" : process.platform
const target = `${platform}-${process.arch}`
const outputName = process.platform === "win32" ? "opencode-server.exe" : "opencode-server"
const fossilizedName = `opencode-server-${target}${process.platform === "win32" ? ".exe" : ""}`
const require = createRequire(import.meta.url)
const coreRequire = createRequire(path.join(root, "packages/core/package.json"))
const ptyPackage = `@lydell/node-pty-${process.platform}-${process.arch}`
const ptyWrapper = coreRequire.resolve("@lydell/node-pty")
const ptyEntry = coreRequire.resolve(ptyPackage, { paths: [path.dirname(ptyWrapper)] })
const ptyRoot = path.resolve(path.dirname(ptyEntry), "..")
const watcherPackage = `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? "-glibc" : ""}`
const watcher = coreRequire.resolve(watcherPackage)
const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"))
const appDir = path.join(root, "packages/app")
const appDist = path.join(appDir, "dist")

await rm(staging, { recursive: true, force: true })
await mkdir(staging, { recursive: true })
await run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["run", "build"], appDir)

const webFiles = (await listFiles(appDist)).filter((file) => !file.endsWith(".map"))
await cp(appDist, path.join(staging, "web"), { recursive: true })
const webUIModule = `import { getRawAsset, isSea } from "node:sea"
const asset = (key) => isSea() ? new Uint8Array(getRawAsset(key)) : key
export default {
${webFiles.map((file) => `  ${JSON.stringify(file)}: asset(${JSON.stringify(`web/${file}`)}),`).join("\n")}
}`

const bundle = path.join(staging, "server.cjs")
const result = await build({
  absWorkingDir: dir,
  entryPoints: ["src/node-server.ts"],
  outfile: bundle,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  conditions: ["node"],
  minify: true,
  treeShaking: true,
  metafile: true,
  external: ["node-gyp/bin/node-gyp.js"],
  loader: { ".md": "text", ".wasm": "file" },
  assetNames: "assets/[name]-[hash]",
  banner: {
    js: `const __opencode_sea = require("node:sea");
const __opencode_path = require("node:path");
const __opencode_import_meta_url = require("node:url").pathToFileURL(__opencode_sea.isSea() ? process.execPath : __filename).href;
if (!process.env.npm_config_node_gyp) process.env.npm_config_node_gyp = process.execPath;
if (__opencode_sea.isSea() && !process.env.OPENCODE_WATCHER_PATH) process.env.OPENCODE_WATCHER_PATH = __opencode_path.join(__opencode_path.dirname(process.execPath), "native", "watcher.node");`,
  },
  define: {
    "import.meta.url": "__opencode_import_meta_url",
    OPENCODE_MODELS_DEV: "undefined",
    OPENCODE_VERSION: JSON.stringify(process.env.OPENCODE_VERSION || pkg.version),
    OPENCODE_CHANNEL: JSON.stringify(process.env.OPENCODE_CHANNEL || "server"),
    OPENCODE_LIBC: process.platform === "linux" ? JSON.stringify("glibc") : "undefined",
  },
  plugins: [
    {
      name: "node-server-resolution",
      setup(build) {
        build.onResolve({ filter: /^opencode-web-ui\.gen\.ts$/ }, () => ({
          path: "opencode-web-ui.gen.ts",
          namespace: "embedded-web-ui",
        }))
        build.onLoad({ filter: /.*/, namespace: "embedded-web-ui" }, () => ({
          contents: webUIModule,
          loader: "js",
        }))
        build.onLoad({ filter: /\.tsx?$/ }, async (args) => {
          const source = await readFile(args.path, "utf8")
          const contents = source
            .replace(/\s+with\s+\{\s*type:\s*["'](?:file|text|wasm)["']\s*\}/g, "")
            .replace(/,\s*\{\s*with:\s*\{\s*type:\s*["'](?:file|text|wasm)["']\s*\},?\s*\}/g, "")
          if (!args.path.endsWith("migration.gen.ts")) {
            return { contents, loader: args.path.endsWith("x") ? "tsx" : "ts" }
          }
          const imports = [...contents.matchAll(/import\(["'](.+?)["']\)/g)].map((match) => match[1])
          return {
            contents: `${imports.map((value, index) => `import migration${index} from ${JSON.stringify(value)}`).join("\n")}
export const migrations = [${imports.map((_, index) => `migration${index}`).join(",")}]`,
            loader: "ts",
          }
        })
        build.onLoad({ filter: /utils\.js$/ }, async (args) => {
          if (!args.path.startsWith(ptyRoot)) return
          const source = await readFile(args.path, "utf8")
          return {
            contents: source.replace(
              'require(dir + "/" + name + ".node")',
              'require("node:module").createRequire(process.execPath)(require("node:path").resolve(require("node:path").dirname(process.execPath), dir, name + ".node"))',
            ),
            loader: "js",
          }
        })
        build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
          path: require.resolve("jsonc-parser/lib/esm/main.js"),
        }))
        build.onResolve({ filter: /^@lydell\/node-pty$/ }, () => ({ path: ptyEntry }))
        build.onResolve({ filter: /^\.\/(?:unix|windows)Terminal$/ }, (args) => {
          const unavailable = process.platform === "win32" ? "unixTerminal" : "windowsTerminal"
          if (args.path !== `./${unavailable}` || !args.importer.startsWith(ptyRoot)) return
          return { path: args.path, namespace: "unavailable-pty-platform" }
        })
        build.onLoad({ filter: /.*/, namespace: "unavailable-pty-platform" }, () => ({
          contents: "module.exports = {}",
          loader: "js",
        }))
      },
    },
  ],
})

const tuiInputs = Object.keys(result.metafile.inputs).filter((input) => {
  const normalized = input.replaceAll("\\", "/")
  return normalized.includes("../tui/") || normalized.includes("@opentui+")
})
if (tuiInputs.length > 0) throw new Error(`Server bundle includes TUI modules:\n${tuiInputs.join("\n")}`)

process.chdir(staging)
await fossilize(
  {
    nodeVersion: process.env.FOSSILIZE_NODE_VERSION || "24.16.0",
    platforms: [target],
    assets: webFiles.map((file) => `web/${file}`),
    outDir: outdir,
    outputName: "opencode-server",
    cacheDir: path.join(root, ".node-cache"),
    noBundle: true,
    noCodeCache: true,
    ignoreNodeOptions: false,
    sign: false,
    holePunch: false,
    concurrencyLimit: 1,
  },
  bundle,
)

await rename(path.join(outdir, fossilizedName), path.join(outdir, outputName))
await cp(path.join(staging, "assets"), path.join(outdir, "assets"), { recursive: true })
await cp(
  path.join(ptyRoot, "prebuilds", `${process.platform}-${process.arch}`),
  path.join(outdir, "prebuilds", `${process.platform}-${process.arch}`),
  {
    recursive: true,
  },
)
await mkdir(path.join(outdir, "native"), { recursive: true })
await copyFile(watcher, path.join(outdir, "native/watcher.node"))
process.chdir(root)
await rm(staging, { recursive: true, force: true })

console.log(`Built ${path.join(outdir, outputName)}`)

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, OPENCODE_CHANNEL: process.env.OPENCODE_CHANNEL || "server" },
      shell: process.platform === "win32",
      stdio: "inherit",
    })
    child.once("error", reject)
    child.once("exit", (code) => {
      if (code === 0) return resolve()
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`))
    })
  })
}

async function listFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) => {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) return listFiles(root, absolute)
      return path.relative(root, absolute).replaceAll("\\", "/")
    }),
  )
  return files.flat().sort()
}
