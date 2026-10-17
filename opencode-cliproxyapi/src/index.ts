import type { Config, Plugin, PluginModule, PluginOptions } from "@opencode-ai/plugin"
import {
  discoverModelProtocols,
  discoverModels,
  normalizeBaseURL,
  type CatalogModel,
  type ModelInputModality,
  type ModelProtocolCatalog,
} from "./catalog.js"

const DEFAULT_BASE_URL = "http://localhost:8317/v1"
const DEFAULT_PROVIDER_ID = "cliproxyapi"
const DEFAULT_PROVIDER_NAME = "CLIProxyAPI"
const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000
const DEFAULT_MODEL_METADATA_URL = "https://models.dev/api.json"

type ConnectorOptions = {
  baseURL?: string
  modelsURL?: string
  apiKey?: string
  providerID?: string
  providerName?: string
  protocol?: "chat" | "responses"
  modelMetadataURL?: string | false
  discoveryTimeoutMs?: number
}

type ProviderConfig = NonNullable<Config["provider"]>[string]
type LegacyModelConfig = NonNullable<ProviderConfig["models"]>[string]
type ModelVariantConfig = { disabled?: boolean } & Record<string, unknown>
type ModelConfig = LegacyModelConfig & {
  interleaved?: boolean | string | { field: string }
  variants?: Record<string, ModelVariantConfig>
}

const KNOWN_REASONING_VARIANTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

export const CLIProxyAPIPlugin: Plugin = async ({ client }, rawOptions) => {
  const options = readOptions(rawOptions)
  const providerID = options.providerID ?? DEFAULT_PROVIDER_ID

  await client.app.log({
    body: {
      service: "opencode-cliproxyapi",
      level: "info",
      message: `Loaded plugin entrypoint ${import.meta.url}`,
    },
  })

  return {
    config: async (config) => {
      const existing = config.provider?.[providerID]
      const baseURL = normalizeBaseURL(
        options.baseURL ??
          process.env.CLIPROXY_BASE_URL ??
          stringOption(existing?.options?.baseURL) ??
          DEFAULT_BASE_URL,
      )
      const apiKey =
        options.apiKey ??
        process.env.CPA_API_KEY ??
        process.env.CLIPROXY_API_KEY ??
        stringOption(existing?.options?.apiKey)

      try {
        const timeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS
        const [catalog, protocolDiscovery] = await Promise.all([
          discoverModels({
            baseURL,
            modelsURL: options.modelsURL,
            apiKey,
            timeoutMs,
          }),
          discoverProtocols({
            url: options.modelMetadataURL ?? DEFAULT_MODEL_METADATA_URL,
            timeoutMs,
          }),
        ])

        if (protocolDiscovery.error) {
          await client.app.log({
            body: {
              service: "opencode-cliproxyapi",
              level: "warn",
              message: protocolDiscovery.error,
            },
          })
        }

        addProvider(config, {
          providerID,
          providerName: options.providerName ?? DEFAULT_PROVIDER_NAME,
          baseURL,
          apiKey,
          protocol: options.protocol ?? "chat",
          catalog,
          protocolCatalog: protocolDiscovery.catalog,
        })

        await client.app.log({
          body: {
            service: "opencode-cliproxyapi",
            level: "info",
            message: `Discovered ${catalog.length} CLIProxyAPI models from ${baseURL}`,
          },
        })
      } catch (error) {
        await client.app.log({
          body: {
            service: "opencode-cliproxyapi",
            level: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        })
        throw error
      }
    },
    "chat.params": async (input, output) => {
      if (input.model.providerID !== providerID) return

      const effort = stringOption(output.options.reasoningEffort) ?? stringOption(output.options.effort)
      if (!effort) return

      await client.app.log({
        body: {
          service: "opencode-cliproxyapi",
          level: "debug",
          message: `Applying reasoning effort ${effort} to ${input.model.id}`,
        },
      })
    },
  }
}

export default {
  id: "opencode-cliproxyapi",
  server: CLIProxyAPIPlugin,
} satisfies PluginModule
export {
  defaultModelsURL,
  discoverModelProtocols,
  discoverModels,
  normalizeBaseURL,
  parseCatalog,
  parseModelProtocolCatalog,
} from "./catalog.js"
export type { CatalogModel, ModelInputModality, ModelProtocolCatalog } from "./catalog.js"

function addProvider(
  config: Config,
  input: {
    providerID: string
    providerName: string
    baseURL: string
    apiKey?: string
    protocol: "chat" | "responses"
    catalog: CatalogModel[]
    protocolCatalog: ModelProtocolCatalog
  },
) {
  const existing = config.provider?.[input.providerID]
  const discovered: Record<string, ModelConfig> = Object.fromEntries(
    input.catalog.map((model) => {
      const npm = resolveModelNpm(input.protocolCatalog, model.ownedBy, model.id)
      const inputModalities = model.inputModalities ?? inferredInputModalities(model.id)
      const reasoning = model.reasoningLevels
        ? model.reasoningLevels.length > 0
        : isReasoningModel(model.id)
      const variants =
        model.reasoningLevels && model.reasoningLevels.length > 0
          ? reasoningVariants(model.reasoningLevels, npm)
          : undefined

      return [
        model.id,
        {
          name: model.name,
          tool_call: !isImageModel(model.id),
          reasoning,
          attachment: inputModalities.some((modality) => modality !== "text"),
          modalities: {
            input: inputModalities,
            output: isImageModel(model.id) ? ["image"] : ["text"],
          },
          ...(model.contextLimit && model.outputLimit
            ? {
                limit: {
                  context: model.contextLimit,
                  output: model.outputLimit,
                },
              }
            : {}),
          ...(npm === "@ai-sdk/anthropic"
            ? {
                provider: {
                  npm,
                },
              }
            : {}),
          ...(npm === "@ai-sdk/openai-compatible" && reasoning
            ? { interleaved: { field: "reasoning_content" } }
            : {}),
          ...(variants ? { variants } : {}),
        },
      ]
    }),
  )

  config.provider = {
    ...config.provider,
    [input.providerID]: {
      ...existing,
      name: existing?.name ?? input.providerName,
      npm:
        existing?.npm ??
        (input.protocol === "responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible"),
      env: [...new Set([...(existing?.env ?? []), "CPA_API_KEY", "CLIPROXY_API_KEY"])],
      options: {
        ...existing?.options,
        baseURL: input.baseURL,
        ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      },
      models: mergeModels(discovered, existing?.models),
    },
  }
}

function resolveModelNpm(
  catalog: ModelProtocolCatalog,
  providerID: string | undefined,
  modelID: string,
): "@ai-sdk/anthropic" | "@ai-sdk/openai-compatible" {
  const provider = providerID ? catalog[providerID] : undefined
  const discovered = provider?.models[modelID] ?? provider?.npm
  if (discovered === "@ai-sdk/anthropic" || /^claude(?:-|$)/i.test(modelID)) {
    return "@ai-sdk/anthropic"
  }
  return "@ai-sdk/openai-compatible"
}

function mergeModels(
  discovered: Record<string, ModelConfig>,
  existing: ProviderConfig["models"],
): Record<string, ModelConfig> {
  const merged = { ...discovered }

  for (const [modelID, model] of Object.entries((existing ?? {}) as Record<string, ModelConfig>)) {
    const discoveredModel = merged[modelID]
    const providerNpm = model.provider?.npm ?? discoveredModel?.provider?.npm
    merged[modelID] = {
      ...discoveredModel,
      ...model,
      ...(providerNpm ? { provider: { npm: providerNpm } } : {}),
    }
  }

  return merged
}

function readOptions(input?: PluginOptions): ConnectorOptions {
  if (!input) return {}

  return {
    baseURL: stringOption(input.baseURL),
    modelsURL: stringOption(input.modelsURL),
    apiKey: stringOption(input.apiKey),
    providerID: stringOption(input.providerID),
    providerName: stringOption(input.providerName),
    protocol: input.protocol === "responses" ? "responses" : input.protocol === "chat" ? "chat" : undefined,
    modelMetadataURL:
      input.modelMetadataURL === false ? false : stringOption(input.modelMetadataURL),
    discoveryTimeoutMs:
      typeof input.discoveryTimeoutMs === "number" && input.discoveryTimeoutMs > 0
        ? input.discoveryTimeoutMs
        : undefined,
  }
}

function discoverProtocols(input: {
  url: string | false
  timeoutMs: number
}): Promise<{ catalog: ModelProtocolCatalog; error?: string }> {
  if (input.url === false) return Promise.resolve({ catalog: {} as ModelProtocolCatalog })

  return discoverModelProtocols({
    url: input.url,
    timeoutMs: input.timeoutMs,
  })
    .then((catalog) => ({ catalog }))
    .catch((error) => ({
      catalog: {} as ModelProtocolCatalog,
      error: error instanceof Error ? error.message : String(error),
    }))
}

function stringOption(value: unknown) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

function isImageModel(modelID: string) {
  return /(?:^|-)image(?:-|$)/i.test(modelID)
}

function isReasoningModel(modelID: string) {
  return /thinking|reasoning|codex|gpt-(?:5|oss)/i.test(modelID)
}

function inferredInputModalities(modelID: string): ModelInputModality[] {
  return /^(?:claude|gemini|gpt)/i.test(modelID) || isImageModel(modelID)
    ? ["text", "image"]
    : ["text"]
}

function reasoningVariants(
  levels: string[],
  npm: "@ai-sdk/anthropic" | "@ai-sdk/openai-compatible",
): Record<string, ModelVariantConfig> {
  const supported = new Set(levels)
  const allLevels = [...new Set([...KNOWN_REASONING_VARIANTS, ...levels])]

  return Object.fromEntries(
    allLevels.map((effort) => {
      if (!supported.has(effort)) return [effort, { disabled: true }]
      if (npm === "@ai-sdk/anthropic") {
        return [effort, { thinking: { type: "adaptive" }, effort }]
      }
      return [effort, { reasoningEffort: effort }]
    }),
  )
}
