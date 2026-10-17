export const MODEL_INPUT_MODALITIES = ["text", "audio", "image", "video", "pdf"] as const

export type ModelInputModality = (typeof MODEL_INPUT_MODALITIES)[number]

export type CatalogModel = {
  id: string
  name: string
  ownedBy?: string
  contextLimit?: number
  outputLimit?: number
  inputModalities?: ModelInputModality[]
  reasoningLevels?: string[]
}

export type ModelProtocolCatalog = Record<
  string,
  {
    npm?: string
    models: Record<string, string>
  }
>

type CatalogResponse = {
  models?: unknown
  data?: unknown
}

export function normalizeBaseURL(value: string) {
  const url = new URL(value)
  const pathname = url.pathname.replace(/\/+$/, "")
  url.pathname = pathname.endsWith("/v1") ? pathname : `${pathname}/v1`
  return url.toString().replace(/\/$/, "")
}

export function defaultModelsURL(baseURL: string) {
  const url = new URL(`${baseURL.replace(/\/$/, "")}/models`)
  url.searchParams.set("client_version", "pi")
  return url.toString()
}

export function parseCatalog(input: unknown): CatalogModel[] {
  if (!isRecord(input)) throw new Error("CLIProxyAPI returned a non-object model catalog")

  const response: CatalogResponse = input
  const entries = Array.isArray(response.models)
    ? response.models
    : Array.isArray(response.data)
      ? response.data
      : undefined

  if (!entries) {
    throw new Error("CLIProxyAPI model catalog is missing the models or data array")
  }

  const unique = new Map<string, CatalogModel>()
  for (const item of entries) {
    const model = parseCatalogModel(item)
    if (!model) continue

    const existing = unique.get(model.id)
    if (!existing || modelCompleteness(model) > modelCompleteness(existing)) {
      unique.set(model.id, model)
    }
  }

  if (unique.size === 0) throw new Error("CLIProxyAPI returned no usable models")
  return [...unique.values()]
}

export async function discoverModels(input: {
  baseURL: string
  modelsURL?: string
  apiKey?: string
  timeoutMs: number
  fetcher?: typeof fetch
}) {
  const primaryURL = input.modelsURL ?? defaultModelsURL(input.baseURL)
  const fallbackURL = `${input.baseURL.replace(/\/$/, "")}/models`

  try {
    return await fetchCatalog(primaryURL, input)
  } catch (primaryError) {
    if (primaryURL === fallbackURL) throw primaryError

    try {
      return await fetchCatalog(fallbackURL, input)
    } catch (fallbackError) {
      throw new Error(
        `CLIProxyAPI model discovery failed at the Pi and standard endpoints: ${errorMessage(primaryError)}; fallback: ${errorMessage(fallbackError)}`,
      )
    }
  }
}

export function parseModelProtocolCatalog(input: unknown): ModelProtocolCatalog {
  if (!isRecord(input)) throw new Error("Model metadata service returned a non-object catalog")

  return Object.fromEntries(
    Object.entries(input).flatMap(([providerID, provider]) => {
      if (!isRecord(provider)) return []

      const models = Object.fromEntries(
        Object.entries(isRecord(provider.models) ? provider.models : {}).flatMap(([modelID, model]) => {
          if (!isRecord(model) || !isRecord(model.provider) || typeof model.provider.npm !== "string") {
            return []
          }
          return [[modelID, model.provider.npm]]
        }),
      )

      const npm = typeof provider.npm === "string" ? provider.npm : undefined
      return npm || Object.keys(models).length > 0
        ? [[providerID, { ...(npm ? { npm } : {}), models }]]
        : []
    }),
  )
}

export async function discoverModelProtocols(input: {
  url: string
  timeoutMs: number
  fetcher?: typeof fetch
}) {
  const response = await (input.fetcher ?? fetch)(input.url, {
    signal: AbortSignal.timeout(input.timeoutMs),
  })

  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 300)
    throw new Error(
      `Model protocol discovery failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    )
  }

  return parseModelProtocolCatalog(await response.json())
}

async function fetchCatalog(
  url: string,
  input: {
    apiKey?: string
    timeoutMs: number
    fetcher?: typeof fetch
  },
) {
  const response = await (input.fetcher ?? fetch)(url, {
    headers: input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : undefined,
    signal: AbortSignal.timeout(input.timeoutMs),
  })

  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 300)
    throw new Error(
      `CLIProxyAPI model discovery failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    )
  }

  return parseCatalog(await response.json())
}

function parseCatalogModel(input: unknown): CatalogModel | undefined {
  if (!isRecord(input) || input.visibility === "hide") return

  const id = firstString(input.slug, input.id)
  if (!id) return

  const name = firstString(input.display_name, input.name) ?? id
  const ownedBy = firstString(input.owned_by)
  const contextLimit = firstPositiveNumber(
    input.context_window,
    input.max_context_window,
    input.context_length,
  )
  const outputLimit = firstPositiveNumber(input.max_tokens, input.max_completion_tokens)
  const inputModalities = parseInputModalities(input.input_modalities)
  const reasoningLevels = parseReasoningLevels(input.supported_reasoning_levels)

  return {
    id,
    name,
    ...(ownedBy ? { ownedBy } : {}),
    ...(contextLimit ? { contextLimit } : {}),
    ...(outputLimit ? { outputLimit } : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(reasoningLevels ? { reasoningLevels } : {}),
  }
}

function parseInputModalities(value: unknown): ModelInputModality[] | undefined {
  if (!Array.isArray(value)) return

  const supported = new Set<string>(MODEL_INPUT_MODALITIES)
  return [
    ...new Set(
      value.filter(
        (item): item is ModelInputModality => typeof item === "string" && supported.has(item),
      ),
    ),
  ]
}

function parseReasoningLevels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return

  return [
    ...new Set(
      value.flatMap((item) => {
        if (!isRecord(item)) return []
        const effort = firstString(item.effort)
        return effort ? [effort] : []
      }),
    ),
  ]
}

function modelCompleteness(model: CatalogModel) {
  return (
    Number(model.name !== model.id) +
    Number(model.ownedBy !== undefined) +
    Number(model.contextLimit !== undefined) +
    Number(model.outputLimit !== undefined) +
    Number(model.inputModalities !== undefined) +
    Number(model.reasoningLevels !== undefined)
  )
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim()
  }
}

function firstPositiveNumber(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value)
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
