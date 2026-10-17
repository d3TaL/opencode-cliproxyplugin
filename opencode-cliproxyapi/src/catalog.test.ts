import { describe, expect, test } from "bun:test"
import {
  defaultModelsURL,
  discoverModelProtocols,
  discoverModels,
  normalizeBaseURL,
  parseCatalog,
  parseModelProtocolCatalog,
} from "./catalog.js"

describe("normalizeBaseURL", () => {
  test.each([
    ["http://cliproxy.test:8317", "http://cliproxy.test:8317/v1"],
    ["http://cliproxy.test:8317/", "http://cliproxy.test:8317/v1"],
    ["http://cliproxy.test:8317/v1", "http://cliproxy.test:8317/v1"],
    ["https://example.com/proxy/", "https://example.com/proxy/v1"],
  ])("%s becomes %s", (input, expected) => {
    expect(normalizeBaseURL(input)).toBe(expected)
  })

  test("builds the enriched Pi catalog URL", () => {
    expect(defaultModelsURL("https://cliproxy.test/v1")).toBe(
      "https://cliproxy.test/v1/models?client_version=pi",
    )
  })
})

describe("parseCatalog", () => {
  test("maps the enriched Pi catalog without guessing metadata", () => {
    expect(
      parseCatalog({
        models: [
          {
            slug: "gemini-3-flash",
            id: "ignored-id",
            display_name: "Gemini 3 Flash",
            name: "Ignored Name",
            context_window: 1_048_576,
            max_context_window: 500_000,
            context_length: 100_000,
            max_tokens: 65_536,
            max_completion_tokens: 4_096,
            input_modalities: ["text", "image", "image", "unknown"],
            supported_reasoning_levels: [
              { effort: "minimal" },
              { effort: "low" },
              { effort: "high" },
              { effort: "high" },
              {},
            ],
            visibility: "show",
          },
          { slug: "hidden-model", visibility: "hide" },
          { slug: "" },
          null,
        ],
      }),
    ).toEqual([
      {
        id: "gemini-3-flash",
        name: "Gemini 3 Flash",
        contextLimit: 1_048_576,
        outputLimit: 65_536,
        inputModalities: ["text", "image"],
        reasoningLevels: ["minimal", "low", "high"],
      },
    ])
  })

  test("supports standard OpenAI data and selects the most complete duplicate", () => {
    expect(
      parseCatalog({
        data: [
          { id: "gpt-5.6-terra", object: "model" },
          {
            id: "gpt-5.6-terra",
            name: "Terra",
            owned_by: "openai",
            context_length: 200_000,
            max_completion_tokens: 32_000,
          },
          { id: "claude-sonnet-4-6" },
          { id: "" },
        ],
      }),
    ).toEqual([
      {
        id: "gpt-5.6-terra",
        name: "Terra",
        ownedBy: "openai",
        contextLimit: 200_000,
        outputLimit: 32_000,
      },
      { id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" },
    ])
  })

  test("rejects malformed responses", () => {
    expect(() => parseCatalog({ data: {} })).toThrow("models or data array")
    expect(() => parseCatalog({ models: [] })).toThrow("no usable models")
  })
})

describe("discoverModels", () => {
  test("uses the Pi catalog and bearer authentication", async () => {
    let request: Request | undefined
    const models = await discoverModels({
      baseURL: "http://cliproxy.test/v1",
      apiKey: "secret",
      timeoutMs: 1_000,
      fetcher: async (input, init) => {
        request = new Request(input, init)
        return Response.json({ models: [{ slug: "gemini-3-flash", display_name: "Gemini" }] })
      },
    })

    expect(request?.url).toBe("http://cliproxy.test/v1/models?client_version=pi")
    expect(request?.headers.get("authorization")).toBe("Bearer secret")
    expect(models).toEqual([{ id: "gemini-3-flash", name: "Gemini" }])
  })

  test("accepts a standard catalog returned by the Pi endpoint", async () => {
    const requested: string[] = []
    const models = await discoverModels({
      baseURL: "http://cliproxy.test/v1",
      timeoutMs: 1_000,
      fetcher: async (input) => {
        requested.push(String(input))
        return Response.json({ data: [{ id: "standard-model" }] })
      },
    })

    expect(requested).toEqual(["http://cliproxy.test/v1/models?client_version=pi"])
    expect(models).toEqual([{ id: "standard-model", name: "standard-model" }])
  })

  test("falls back to the standard endpoint when the Pi endpoint is unavailable", async () => {
    const requested: string[] = []
    const models = await discoverModels({
      baseURL: "http://cliproxy.test/v1",
      timeoutMs: 1_000,
      fetcher: async (input) => {
        requested.push(String(input))
        if (String(input).includes("client_version=pi")) {
          return Response.json({ error: "unsupported query" }, { status: 404 })
        }
        return Response.json({ data: [{ id: "fallback-model" }] })
      },
    })

    expect(requested).toEqual([
      "http://cliproxy.test/v1/models?client_version=pi",
      "http://cliproxy.test/v1/models",
    ])
    expect(models).toEqual([{ id: "fallback-model", name: "fallback-model" }])
  })

  test("reports both endpoint failures with useful detail", async () => {
    await expect(
      discoverModels({
        baseURL: "http://cliproxy.test/v1",
        timeoutMs: 1_000,
        fetcher: async () => Response.json({ error: "Missing API key" }, { status: 401 }),
      }),
    ).rejects.toThrow("Pi and standard endpoints")
  })
})

describe("parseModelProtocolCatalog", () => {
  test("indexes provider defaults and model-level SDK overrides", () => {
    expect(
      parseModelProtocolCatalog({
        acme: {
          npm: "@ai-sdk/openai-compatible",
          models: {
            "chat-model": {},
            "messages-model": {
              provider: {
                npm: "@ai-sdk/anthropic",
              },
            },
          },
        },
        malformed: {
          models: [],
        },
      }),
    ).toEqual({
      acme: {
        npm: "@ai-sdk/openai-compatible",
        models: {
          "messages-model": "@ai-sdk/anthropic",
        },
      },
    })
  })

  test("rejects a malformed catalog", () => {
    expect(() => parseModelProtocolCatalog([])).toThrow("non-object catalog")
  })
})

describe("discoverModelProtocols", () => {
  test("fetches protocol metadata from the configured URL", async () => {
    let requestedURL = ""
    const catalog = await discoverModelProtocols({
      url: "https://metadata.test/models.json",
      timeoutMs: 1_000,
      fetcher: async (input) => {
        requestedURL = String(input)
        return Response.json({
          acme: {
            models: {
              "messages-model": {
                provider: {
                  npm: "@ai-sdk/anthropic",
                },
              },
            },
          },
        })
      },
    })

    expect(requestedURL).toBe("https://metadata.test/models.json")
    expect(catalog).toEqual({
      acme: {
        models: {
          "messages-model": "@ai-sdk/anthropic",
        },
      },
    })
  })
})
