import path from "path"
import crypto from "crypto"
import { experimental_createMCPClient, type Tool } from "ai"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { App } from "../app/app"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { NamedError } from "../util/error"
import { z } from "zod"
import { Session } from "../session"
import { Bus } from "../bus"
import { Global } from "../global"

export namespace MCP {
  const log = Log.create({ service: "mcp" })

  type ApprovalRecords = {
    [projectKey: string]: {
      [mcpKey: string]: {
        hash: string
        approved: boolean
        time: number
      }
    }
  }

  export const mcpApprovalsJson = path.join(Global.Path.data, "mcp-approvals.json")

  export function normalizedSpec(mcp: Config.Mcp) {
    return mcp.type === "local"
      ? { type: mcp.type, command: mcp.command, environment: mcp.environment ?? {} }
      : { type: mcp.type, url: mcp.url, headers: mcp.headers ?? {} }
  }

  export function specHash(name: string, mcp: Config.Mcp) {
    const json = JSON.stringify({ name, normalized: normalizedSpec(mcp) })
    return crypto.createHash("sha256").update(json).digest("hex")
  }

  export async function isFromGlobal(mcp: Config.Mcp, name: string) {
    const globalCfg = await Config.global()
    const globalSpec = globalCfg.mcp?.[name]
    return globalSpec && JSON.stringify(normalizedSpec(globalSpec)) === JSON.stringify(normalizedSpec(mcp))
  }

  export async function readApprovals() {
    const file = Bun.file(mcpApprovalsJson)
    const allApprovals: ApprovalRecords = await file.json().catch(() => ({}))
    return allApprovals || {}
  }

  export const Failed = NamedError.create(
    "MCPFailed",
    z.object({
      name: z.string(),
    }),
  )

  const state = App.state(
    "mcp",
    async () => {
      const cfg = await Config.get()
      const clients: {
        [name: string]: Awaited<ReturnType<typeof experimental_createMCPClient>>
      } = {}
      const allApprovals = await readApprovals()
      const app = App.info()
      const projectApprovals = allApprovals[app.path.root] || {}

      for (const [name, mcp] of Object.entries(cfg.mcp ?? {})) {
        if (mcp.enabled === false) {
          log.info("mcp server disabled", { key: name })
          continue
        }

        const approval = projectApprovals[name]
        if (approval?.approved === false) {
          log.info("mcp server rejected", { key: name })
          continue
        }

        const hash = specHash(name, mcp)
        const specChanged = approval?.hash !== hash
        const isApproved = approval?.approved && !specChanged
        if (!(await isFromGlobal(mcp, name)) && !isApproved) {
          const msg =
            approval?.approved && specChanged
              ? `MCP server "${name}" has changed since last approval. Run 'opencode mcp approve' to review and enable it.`
              : `MCP server "${name}" requires approval. Run 'opencode mcp approve' to review and enable it.`
          log.info("mcp server awaiting approval", { key: name, type: mcp.type })
          Bus.publish(Session.Event.Error, {
            error: {
              name: "UnknownError",
              data: {
                message: msg,
              },
            },
          })
          continue
        }

        log.info("found", { key: name, type: mcp.type })
        if (mcp.type === "remote") {
          const transports = [
            {
              name: "StreamableHTTP",
              transport: new StreamableHTTPClientTransport(new URL(mcp.url), {
                requestInit: {
                  headers: mcp.headers,
                },
              }),
            },
            {
              name: "SSE",
              transport: new SSEClientTransport(new URL(mcp.url), {
                requestInit: {
                  headers: mcp.headers,
                },
              }),
            },
          ]
          let lastError: Error | undefined
          for (const { name, transport } of transports) {
            const client = await experimental_createMCPClient({
              name: name,
              transport,
            }).catch((error) => {
              lastError = error instanceof Error ? error : new Error(String(error))
              log.debug("transport connection failed", {
                key: name,
                transport: name,
                url: mcp.url,
                error: lastError.message,
              })
              return null
            })
            if (client) {
              log.debug("transport connection succeeded", { key: name, transport: name })
              clients[name] = client
              break
            }
          }
          if (!clients[name]) {
            const errorMessage = lastError
              ? `MCP server ${name} failed to connect: ${lastError.message}`
              : `MCP server ${name} failed to connect to ${mcp.url}`
            log.error("remote mcp connection failed", { key: name, url: mcp.url, error: lastError?.message })
            Bus.publish(Session.Event.Error, {
              error: {
                name: "UnknownError",
                data: {
                  message: errorMessage,
                },
              },
            })
          }
        }

        if (mcp.type === "local") {
          const [cmd, ...args] = mcp.command
          const client = await experimental_createMCPClient({
            name: name,
            transport: new StdioClientTransport({
              stderr: "ignore",
              command: cmd,
              args,
              env: {
                ...process.env,
                ...(cmd === "opencode" ? { BUN_BE_BUN: "1" } : {}),
                ...mcp.environment,
              },
            }),
          }).catch((error) => {
            const errorMessage =
              error instanceof Error
                ? `MCP server ${name} failed to start: ${error.message}`
                : `MCP server ${name} failed to start`
            log.error("local mcp startup failed", {
              key: name,
              command: mcp.command,
              error: error instanceof Error ? error.message : String(error),
            })
            Bus.publish(Session.Event.Error, {
              error: {
                name: "UnknownError",
                data: {
                  message: errorMessage,
                },
              },
            })
            return null
          })
          if (client) {
            clients[name] = client
          }
        }
      }

      return {
        clients,
      }
    },
    async (state) => {
      for (const client of Object.values(state.clients)) {
        client.close()
      }
    },
  )

  export async function clients() {
    return state().then((state) => state.clients)
  }

  export async function tools() {
    const result: Record<string, Tool> = {}
    for (const [clientName, client] of Object.entries(await clients())) {
      for (const [toolName, tool] of Object.entries(await client.tools())) {
        const sanitizedClientName = clientName.replace(/\s+/g, "_")
        result[sanitizedClientName + "_" + toolName] = tool
      }
    }
    return result
  }
}
