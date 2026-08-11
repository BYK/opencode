#!/usr/bin/env node

import { Flag } from "@opencode-ai/core/flag/flag"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { existsSync } from "node:fs"
import { Module } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { Server } from "./server/server"

type ResolveContext = { parentURL?: string }
type NextResolve = (specifier: string, context: ResolveContext) => unknown
type ResolveHook = (specifier: string, context: ResolveContext, nextResolve: NextResolve) => unknown
const registerHooks = (
  Module as typeof Module & { registerHooks(hooks: { resolve: ResolveHook }): void }
).registerHooks

const help = `opencode-server ${InstallationVersion}

Usage: opencode-server [options]

Options:
  --hostname <host>       Hostname to listen on (default: 127.0.0.1)
  --port <port>           Port to listen on (default: 0)
  --cors <origin>         Additional allowed CORS origin (repeatable)
  --mdns                  Enable mDNS service discovery
  --mdns-domain <domain>  mDNS domain (default: opencode.local)
  --help, -h              Show help
  --version, -v           Show version
`

async function main() {
  // Older Bun-compatible plugins may emit extensionless relative ESM imports, which Node does not resolve.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ERR_MODULE_NOT_FOUND" ||
          !context.parentURL?.startsWith("file:") ||
          (!specifier.startsWith("./") && !specifier.startsWith("../"))
        )
          throw error

        const target = new URL(specifier, context.parentURL)
        if (path.extname(fileURLToPath(target))) throw error
        const resolved = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]
          .map((extension) => new URL(`${specifier}${extension}`, context.parentURL))
          .find((candidate) => existsSync(fileURLToPath(candidate)))
        if (!resolved) throw error
        return nextResolve(resolved.href, context)
      }
    },
  })

  const args = parseArgs({
    options: {
      hostname: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "0" },
      cors: { type: "string", multiple: true, default: [] },
      mdns: { type: "boolean", default: false },
      "mdns-domain": { type: "string", default: "opencode.local" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    allowPositionals: false,
  })

  if (args.values.help) {
    process.stdout.write(help)
    return
  }
  if (args.values.version) {
    console.log(InstallationVersion)
    return
  }

  const port = Number(args.values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${args.values.port}`)
  }

  process.env.AGENT = "1"
  process.env.OPENCODE = "1"
  process.env.OPENCODE_PID = String(process.pid)

  if (!Flag.OPENCODE_SERVER_PASSWORD) {
    console.warn("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
  }

  const server = await Server.listen({
    hostname: args.values.hostname,
    port,
    cors: args.values.cors,
    mdns: args.values.mdns,
    mdnsDomain: args.values["mdns-domain"],
  })
  console.log(`opencode server listening on ${server.url}`)

  await new Promise<void>((resolve, reject) => {
    const stop = () => server.stop(true).then(resolve, reject)
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
