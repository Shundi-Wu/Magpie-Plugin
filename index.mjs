// magpie / OpenCode provider plugin for the GitHub Copilot API (CAPI),
// signed per request with an integration's HMAC secret instead of a token.
//
// Sign in with `magpie plugin login capi`: the key is the HMAC secret and
// the integration id is asked next. Options (magpie plugin options
// magpie-capi-hmac '{…}'): baseURL, apiVersion, dropBetas.

import { createHmac, randomUUID } from "node:crypto"

const PROVIDER = "capi"

// betas CAPI turns away with a 400
const UNSUPPORTED_BETAS = ["advisor-tool-2026-03-01"]

// one model per API, so provider.models has a template of each
const TEMPLATE = { anthropic: "claude-opus-5.5", responses: "gpt-5.5", chat: "kimi-k3" }

export const CapiHmacPlugin = async (_input, options = {}) => {
  const base = (options.baseURL ?? "https://api.githubcopilot.com").replace(/\/+$/, "")
  const apiVersion = options.apiVersion ?? "2025-10-01"
  const dropBetas = new Set([...UNSUPPORTED_BETAS, ...(options.dropBetas ?? [])])
  const apis = {
    anthropic: { npm: "@ai-sdk/anthropic", api: `${base}/v1` }, // → /v1/messages
    responses: { npm: "@ai-sdk/openai", api: base }, // → /responses
    chat: { npm: "@ai-sdk/openai-compatible", api: base }, // → /chat/completions
  }

  // the integration id asked at sign-in
  const integrationOf = (auth) => {
    const id = auth?.metadata?.integrationId
    if (!id) throw new Error("capi: no integration id; sign in again")
    return id
  }

  // the headers that authenticate a request, on top of what it already has
  const sign = (headers, auth) => {
    // the saved key is the HMAC secret: it must never leave as a key header
    headers.delete("x-api-key")
    // CAPI checks that Authorization is there, empty, on an HMAC request
    headers.set("authorization", "")
    headers.set("copilot-integration-id", integrationOf(auth))
    headers.set("request-hmac", requestHmac(auth.key))
    headers.set("x-github-api-version", apiVersion)
    headers.set("openai-intent", "conversation-agent")
    headers.set("x-interaction-type", "conversation-agent")
    if (!headers.has("x-interaction-id")) headers.set("x-interaction-id", randomUUID())
    // the body goes back as it comes, so ask for it uncompressed
    headers.set("accept-encoding", "identity")
    const betas = headers.get("anthropic-beta")
    if (betas !== null) {
      const kept = betas.split(",").map((b) => b.trim()).filter((b) => b && !dropBetas.has(b))
      if (kept.length) headers.set("anthropic-beta", kept.join(","))
      else headers.delete("anthropic-beta")
    }
    return headers
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "Copilot API (HMAC)",
        npm: apis.responses.npm,
        api: apis.responses.api,
        models: {
          [TEMPLATE.anthropic]: {
            name: "Claude Opus 5.5",
            provider: apis.anthropic,
            reasoning: true,
            tool_call: true,
            attachment: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            variants: { low: {}, medium: {}, high: {}, xhigh: {}, max: {} },
          },
          [TEMPLATE.responses]: {
            name: "GPT-5.5",
            provider: apis.responses,
            reasoning: true,
            tool_call: true,
            attachment: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            variants: { none: {}, low: {}, medium: {}, high: {}, xhigh: {} },
          },
          [TEMPLATE.chat]: {
            name: "Kimi K3",
            provider: apis.chat,
            reasoning: true,
            tool_call: true,
            attachment: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            variants: { low: {}, high: {}, max: {} },
          },
        },
      }
    },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: "api",
          label: "CAPI HMAC secret",
          prompts: [
            {
              type: "text",
              key: "integrationId",
              message: "Copilot integration id",
              placeholder: "my-integration-dev",
              validate: (v) => (v?.trim() ? undefined : "Required"),
            },
          ],
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api") return {}
        return {
          // a stand-in, so the secret is never put in a key header
          apiKey: "capi-hmac",
          async fetch(input, init) {
            const headers = sign(new Headers(init?.headers), auth)
            return fetch(input, { ...init, headers })
          },
        }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api") return provider.models
        const res = await fetch(`${base}/models`, {
          headers: sign(new Headers({ accept: "application/json" }), auth),
          signal: AbortSignal.timeout(30000),
        }).catch(() => null)
        // unanswered or refused: magpie keeps the list it had
        if (!res?.ok) return provider.models
        const { data } = await res.json()
        const models = {}
        for (const m of data ?? []) {
          const caps = m.capabilities ?? {}
          if (caps.type !== "chat" || m.model_picker_enabled === false) continue
          const kind = apiOf(m.supported_endpoints)
          const template = provider.models?.[TEMPLATE[kind]] ?? {}
          const limits = caps.limits ?? {}
          const supports = caps.supports ?? {}
          const efforts = Array.isArray(supports.reasoning_effort) ? supports.reasoning_effort : []
          const image = !!supports.vision
          models[m.id] = {
            ...template,
            id: m.id,
            providerID: PROVIDER,
            name: m.name ?? m.id,
            api: { ...template.api, id: m.id, url: apis[kind].api, npm: apis[kind].npm },
            limit: {
              // max_prompt_tokens, not the window: CAPI always lets at least
              // this much through, and for some models no more (GPT-5.2-Codex
              // stops at 272K of its 400K window)
              context: limits.max_prompt_tokens ?? 128000,
              output: limits.max_output_tokens ?? 4096,
            },
            capabilities: {
              ...template.capabilities,
              reasoning: efforts.length > 0 || !!supports.adaptive_thinking || !!supports.max_thinking_budget,
              toolcall: supports.tool_calls !== false,
              attachment: image,
              input: { ...template.capabilities?.input, text: true, image },
            },
            variants: Object.fromEntries(efforts.map((e) => [e, {}])),
            status: m.preview ? "beta" : "active",
          }
        }
        return Object.keys(models).length ? models : provider.models
      },
    },

    // one interaction id per conversation, rather than one per request
    "chat.headers": async (input, output) => {
      if (input.model?.providerID === PROVIDER && input.sessionID) {
        output.headers["x-interaction-id"] = input.sessionID
      }
    },
  }
}

// the API a model is served on, from CAPI's supported_endpoints
function apiOf(endpoints) {
  const eps = endpoints ?? []
  if (eps.includes("/v1/messages")) return "anthropic"
  if (eps.includes("/responses")) return "responses"
  return "chat"
}

// "<unix seconds>.<uppercase hex HMAC-SHA256 of them>"
function requestHmac(secret) {
  const ts = Math.floor(Date.now() / 1000).toString()
  return `${ts}.${createHmac("sha256", secret).update(ts).digest("hex").toUpperCase()}`
}
