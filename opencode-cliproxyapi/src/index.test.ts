import { afterEach, describe, expect, test } from "bun:test"
import type { Config, PluginInput } from "@opencode-ai/plugin"
import { CLIProxyAPIPlugin } from "./index.js"

const originalFetch = globalThis.fetch
const originalCPAKey = process.env.CPA_API_KEY

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalCPAKey === undefined) delete process.env.CPA_API_KEY
  else process.env.CPA_API_KEY = originalCPAKey
})

describe("CLIProxyAPIPlugin", () => {
  test("maps Pi metadata to current OpenCode model configuration", async () => {
    const requests: Request[] = []
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      if (request.url === "https://models.dev/api.json") return Response.json({})

      return Response.json({
        models: [
          {
            slug: "gemini-3-flash",
            display_name: "Gemini 3 Flash",
            context_window: 1_048_576,
            max_tokens: 65_536,
            input_modalities: ["text", "image"],
            supported_reasoning_levels: [
              { effort: "minimal" },
              { effort: "low" },
              { effort: "medium" },
              { effort: "high" },
            ],
          },
          {
            slug: "claude-sonnet-4-6",
            display_name: "Claude Sonnet 4.6",
            context_window: 200_000,
            max_tokens: 64_000,
            input_modalities: ["text", "image"],
            supported_reasoning_levels: [
              { effort: "low" },
              { effort: "medium" },
              { effort: "high" },
              { effort: "xhigh" },
            ],
          },
          {
            slug: "plain-model",
            display_name: "Plain Model",
            context_window: 32_000,
            max_tokens: 4_096,
            input_modalities: ["text"],
            supported_reasoning_levels: [],
          },
          { slug: "hidden-model", visibility: "hide" },
        ],
      })
    }
    process.env.CPA_API_KEY = "environment-secret"

    const { config, logs } = await applyPlugin({
      baseURL: "http://cliproxy.test:8317",
    })

    const modelRequest = requests.find((request) => request.url.includes("/models?"))
    expect(modelRequest?.url).toBe("http://cliproxy.test:8317/v1/models?client_version=pi")
    expect(modelRequest?.headers.get("authorization")).toBe("Bearer environment-secret")
    expect(config.provider?.cliproxyapi).toMatchObject({
      name: "CLIProxyAPI",
      npm: "@ai-sdk/openai-compatible",
      env: ["CPA_API_KEY", "CLIPROXY_API_KEY"],
      options: {
        baseURL: "http://cliproxy.test:8317/v1",
        apiKey: "environment-secret",
      },
      models: {
        "gemini-3-flash": {
          name: "Gemini 3 Flash",
          reasoning: true,
          attachment: true,
          interleaved: { field: "reasoning_content" },
          limit: { context: 1_048_576, output: 65_536 },
          modalities: { input: ["text", "image"], output: ["text"] },
          variants: {
            none: { disabled: true },
            minimal: { reasoningEffort: "minimal" },
            low: { reasoningEffort: "low" },
            medium: { reasoningEffort: "medium" },
            high: { reasoningEffort: "high" },
            xhigh: { disabled: true },
            max: { disabled: true },
          },
        },
        "claude-sonnet-4-6": {
          name: "Claude Sonnet 4.6",
          reasoning: true,
          attachment: true,
          provider: { npm: "@ai-sdk/anthropic" },
          variants: {
            none: { disabled: true },
            minimal: { disabled: true },
            low: { thinking: { type: "adaptive" }, effort: "low" },
            medium: { thinking: { type: "adaptive" }, effort: "medium" },
            high: { thinking: { type: "adaptive" }, effort: "high" },
            xhigh: { thinking: { type: "adaptive" }, effort: "xhigh" },
            max: { disabled: true },
          },
        },
        "plain-model": {
          name: "Plain Model",
          reasoning: false,
          attachment: false,
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    })
    expect(config.provider?.cliproxyapi?.models?.["hidden-model"]).toBeUndefined()
    expect(logs).toHaveLength(2)
    expect(logs[0]).toMatchObject({
      body: { message: expect.stringContaining("opencode-cliproxyapi") },
    })
  })

  test("uses an explicit modelsURL and preserves existing model overrides", async () => {
    const requests: string[] = []
    globalThis.fetch = async (input) => {
      requests.push(String(input))
      if (String(input) === "https://models.dev/api.json") return Response.json({})
      return Response.json({ models: [{ slug: "custom-model", display_name: "Discovered Name" }] })
    }

    const config: Config = {
      provider: {
        cliproxyapi: {
          models: {
            "custom-model": { name: "My Name" },
          },
        },
      },
    }
    await applyPlugin(
      {
        baseURL: "http://cliproxy.test:8317",
        modelsURL: "https://catalog.test/models?client_version=pi",
      },
      config,
    )

    expect(requests).toContain("https://catalog.test/models?client_version=pi")
    expect(config.provider?.cliproxyapi?.models?.["custom-model"]?.name).toBe("My Name")
  })

  test("keeps models available when protocol metadata is unavailable", async () => {
    globalThis.fetch = async (input) => {
      if (String(input) === "https://models.dev/api.json") {
        return Response.json({ error: "unavailable" }, { status: 503 })
      }
      return Response.json({ data: [{ id: "chat-model", owned_by: "acme" }] })
    }

    const { config, logs } = await applyPlugin({ baseURL: "http://cliproxy.test:8317" })

    expect(config.provider?.cliproxyapi?.models?.["chat-model"]).toBeDefined()
    expect(logs).toHaveLength(3)
    expect(logs[1]).toMatchObject({
      body: {
        level: "warn",
        message: expect.stringContaining("HTTP 503"),
      },
    })
  })
})

async function applyPlugin(options: Record<string, unknown>, config: Config = {}) {
  const logs: unknown[] = []
  const plugin = await CLIProxyAPIPlugin(
    {
      client: {
        app: {
          log: async (input: unknown) => {
            logs.push(input)
            return {}
          },
        },
      },
    } as PluginInput,
    options,
  )
  await plugin.config?.(config)
  return { config, logs }
}
