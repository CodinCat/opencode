import crypto from "crypto"
import path from "path"
import fs from "fs/promises"
import { cmd } from "./cmd"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Config } from "../../config/config"
import { Global } from "../../global"
import { App } from "../../app/app"
import { bootstrap } from "../bootstrap"

export const McpCommand = cmd({
  command: "mcp",
  builder: (yargs) => yargs.command(McpAddCommand).command(McpApproveCommand).demandCommand(),
  async handler() {},
})

export const McpAddCommand = cmd({
  command: "add",
  describe: "add an MCP server",
  async handler() {
    UI.empty()
    prompts.intro("Add MCP server")

    const name = await prompts.text({
      message: "Enter MCP server name",
      validate: (x) => x && (x.length > 0 ? undefined : "Required"),
    })
    if (prompts.isCancel(name)) throw new UI.CancelledError()

    const type = await prompts.select({
      message: "Select MCP server type",
      options: [
        {
          label: "Local",
          value: "local",
          hint: "Run a local command",
        },
        {
          label: "Remote",
          value: "remote",
          hint: "Connect to a remote URL",
        },
      ],
    })
    if (prompts.isCancel(type)) throw new UI.CancelledError()

    if (type === "local") {
      const command = await prompts.text({
        message: "Enter command to run",
        placeholder: "e.g., opencode x @modelcontextprotocol/server-filesystem",
        validate: (x) => x && (x.length > 0 ? undefined : "Required"),
      })
      if (prompts.isCancel(command)) throw new UI.CancelledError()

      prompts.log.info(`Local MCP server "${name}" configured with command: ${command}`)
      prompts.outro("MCP server added successfully")
      return
    }

    if (type === "remote") {
      const url = await prompts.text({
        message: "Enter MCP server URL",
        placeholder: "e.g., https://example.com/mcp",
        validate: (x) => {
          if (!x) return "Required"
          if (x.length === 0) return "Required"
          const isValid = URL.canParse(x)
          return isValid ? undefined : "Invalid URL"
        },
      })
      if (prompts.isCancel(url)) throw new UI.CancelledError()

      const client = new Client({
        name: "opencode",
        version: "1.0.0",
      })
      const transport = new StreamableHTTPClientTransport(new URL(url))
      await client.connect(transport)
      prompts.log.info(`Remote MCP server "${name}" configured with URL: ${url}`)
    }

    prompts.outro("MCP server added successfully")
  },
})

function normalizedSpec(mcp: Config.Mcp) {
  return mcp.type === "local"
    ? { type: mcp.type, command: mcp.command, environment: mcp.environment ?? {} }
    : { type: mcp.type, url: mcp.url, headers: mcp.headers ?? {} }
}

function specHash(name: string, mcp: Config.Mcp) {
  const json = JSON.stringify({ name, normalized: normalizedSpec(mcp) })
  return crypto.createHash("sha256").update(json).digest("hex")
}

export const McpApproveCommand = cmd({
  command: "approve",
  describe: "review and approve MCP servers in the current project",
  async handler() {
    await bootstrap({ cwd: process.cwd() }, async () => {
      UI.empty()
      prompts.intro("Approve MCP servers")
      const cfg = await Config.get()
      const globalCfg = await Config.global()
      const app = App.info()
      const approvalsPath = path.join(Global.Path.data, "mcp-approvals.json")
      const file = Bun.file(approvalsPath)
      const approvals: Record<string, any> = await file.json().catch(() => ({}))
      approvals[app.path.root] = approvals[app.path.root] || {}

      const entries = Object.entries(cfg.mcp ?? {})
      if (entries.length === 0) {
        prompts.log.info("No MCP servers defined in config")
        prompts.outro("Done")
        return
      }
      for (const [name, mcp] of entries) {
        if (mcp.enabled === false) {
          prompts.log.info(`${name} ${UI.Style.TEXT_DIM}(disabled)`)
          continue
        }
        // Skip MCPs that are identical to global config
        const globalSpec = globalCfg.mcp?.[name]
        const isGlobalSame =
          globalSpec && JSON.stringify(normalizedSpec(globalSpec)) === JSON.stringify(normalizedSpec(mcp))
        if (isGlobalSame) {
          continue
        }
        const hash = specHash(name, mcp)
        const current = approvals[app.path.root][name]
        const currentApproved: boolean | undefined = current?.approved
        const label =
          mcp.type === "local" ? `${name} (local) ${JSON.stringify(mcp.command)}` : `${name} (remote) ${mcp.url}`

        const res = await prompts.select({
          message: `Approve ${label}?`,
          options: [
            { label: "Approve", value: "approve" },
            { label: "Reject", value: "reject" },
          ],
          initialValue: currentApproved ? "approve" : currentApproved === false ? "reject" : undefined,
        })
        if (prompts.isCancel(res)) throw new UI.CancelledError()

        if (res === "reject") {
          approvals[app.path.root][name] = { approved: false, hash, time: Date.now() }
          continue
        }

        approvals[app.path.root][name] = { approved: true, hash, time: Date.now() }
      }

      await fs.mkdir(path.dirname(approvalsPath), { recursive: true }).catch(() => {})
      await Bun.write(approvalsPath, JSON.stringify(approvals, null, 2))
      await fs.chmod(approvalsPath, 0o600).catch(() => {})

      prompts.outro("Done")
    })
  },
})
