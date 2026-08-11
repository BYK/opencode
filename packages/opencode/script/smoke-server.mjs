#!/usr/bin/env node

import { once } from "node:events"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const executable = process.argv[2]
if (!executable) throw new Error("Usage: smoke-server.mjs <executable>")

const expectedHtml = await readFile(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../app/dist/index.html"),
  "utf8",
)
const home = await mkdtemp(path.join(os.tmpdir(), "opencode-server-smoke-"))
const projectDirectory = path.join(home, "project")
const pluginDirectory = path.join(projectDirectory, "plugin")
const pluginMarker = path.join(home, "plugin-prompt.txt")
await mkdir(pluginDirectory, { recursive: true })
await writeFile(path.join(pluginDirectory, "index.js"), 'export { RegressionPlugin } from "./plugin"\n')
await writeFile(
  path.join(pluginDirectory, "plugin.js"),
  `import { writeFile } from "node:fs/promises"
export async function RegressionPlugin() {
  return {
    async "chat.message"() {
      await writeFile(process.env.OPENCODE_SMOKE_PLUGIN_MARKER, "prompt")
    },
  }
}
`,
)
await writeFile(
  path.join(projectDirectory, "opencode.json"),
  JSON.stringify({
    formatter: false,
    lsp: false,
    plugin: [pathToFileURL(path.join(pluginDirectory, "index.js")).href],
  }),
)
const child = spawn(path.resolve(executable), ["--port", process.env.OPENCODE_SMOKE_PORT || "14096"], {
  env: {
    ...process.env,
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_SERVER_PASSWORD: "smoke-test",
    OPENCODE_SMOKE_PLUGIN_MARKER: pluginMarker,
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"),
  },
  stdio: ["ignore", "pipe", "pipe"],
})
let output = ""
child.stderr.on("data", (chunk) => (output += chunk))

try {
  const url = await Promise.race([
    new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        output += chunk
        const match = output.match(/opencode server listening on (https?:\/\/\S+)/)
        if (match) resolve(match[1])
      })
      child.once("exit", (code) => reject(new Error(`Server exited with code ${code}:\n${output}`)))
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Server startup timed out:\n${output}`)), 15_000)),
  ])

  const headers = { Authorization: `Basic ${Buffer.from("opencode:smoke-test").toString("base64")}` }
  const response = await fetch(new URL("/global/health", url), { headers })
  const body = await response.json()
  if (!response.ok || body.healthy !== true)
    throw new Error(`Health check failed (${response.status}): ${JSON.stringify(body)}`)

  const ui = await fetch(url, { headers })
  const html = await ui.text()
  if (
    !ui.ok ||
    !ui.headers.get("content-type")?.startsWith("text/html") ||
    !html.match(/<!doctype html>/i) ||
    html !== expectedHtml
  ) {
    throw new Error(`WebUI check failed (${ui.status}): ${html.slice(0, 200)}`)
  }
  const script = html.match(/<script[^>]+src=["']([^"']+\.js)["']/i)?.[1]
  if (!script) throw new Error("WebUI check failed: no JavaScript entrypoint found")
  const javascript = await fetch(new URL(script, url), { headers })
  if (!javascript.ok || !javascript.headers.get("content-type")?.includes("javascript")) {
    throw new Error(`WebUI JavaScript check failed (${javascript.status}): ${await javascript.text()}`)
  }

  const projectUrl = new URL("/project", url)
  projectUrl.searchParams.set("directory", projectDirectory)
  const project = await fetch(projectUrl, { headers })
  if (!project.ok) throw new Error(`Project API check failed (${project.status}): ${await project.text()}`)

  const sessionUrl = new URL("/session", url)
  sessionUrl.searchParams.set("directory", projectDirectory)
  const sessionResponse = await fetch(sessionUrl, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: "{}",
  })
  if (!sessionResponse.ok)
    throw new Error(`Session API check failed (${sessionResponse.status}): ${await sessionResponse.text()}`)
  const session = await sessionResponse.json()
  const promptUrl = new URL(`/session/${session.id}/message`, url)
  promptUrl.searchParams.set("directory", projectDirectory)
  const prompt = await fetch(promptUrl, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: { providerID: "smoke", modelID: "smoke" },
      noReply: true,
      parts: [{ type: "text", text: "plugin resolution smoke test" }],
    }),
  })
  if (!prompt.ok) throw new Error(`Prompt API check failed (${prompt.status}): ${await prompt.text()}`)
  if ((await readFile(pluginMarker, "utf8").catch(() => "")) !== "prompt") {
    throw new Error(`Prompt plugin check failed:\n${output}`)
  }

  const ptyUrl = new URL("/pty", url)
  ptyUrl.searchParams.set("directory", projectDirectory)
  const pty = await fetch(ptyUrl, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      command: process.platform === "win32" ? "cmd.exe" : "sh",
      args: process.platform === "win32" ? ["/c", "exit 0"] : ["-c", "exit 0"],
    }),
  })
  if (!pty.ok) throw new Error(`PTY API check failed (${pty.status}): ${await pty.text()}`)

  console.log(`Server smoke checks passed at ${url}`)
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM")
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))])
    if (child.exitCode === null) child.kill("SIGKILL")
  }
  await rm(home, { recursive: true, force: true })
}
