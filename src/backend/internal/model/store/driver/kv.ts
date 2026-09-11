/**
 * KV 驱动（自动适配 Cloudflare / EdgeOne）
 * 
 * 支持两种模式：
 * 1. Binding 模式：直接访问 KV binding（Cloudflare Workers / EdgeOne Edge Functions）
 * 2. HTTP 代理模式：通过 Edge Function 代理访问（EdgeOne Node Functions）
 * 
 * 自动检测环境并选择合适的模式。
 */
import type { Driver, EnvContext } from "../types"

/**
 * 获取 KV binding（Cloudflare 或 EdgeOne Edge Functions）
 */
function getKvBinding(env?: any): any | null {
  const e = env || (globalThis as any) || {}
  return e?.KV || e?.EDGEONE_KV || null
}

/**
 * 检测是否应走 HTTP 代理模式。
 *
 * 条件：当前 env 中没有 KV binding。
 * 注意不能要求 JWT_SECRET 存在——密钥可能只存于 KV（由 getJwtSecret 回退读取），
 * 因此这里放宽判断，真正是否可用由 isAvailable() 的实际探测决定。
 */
function isEdgeOneNodeEnv(env?: any): boolean {
  return getKvBinding(env) === null
}

/**
 * 获取代理内部调用密钥。
 *
 * 必须与 Node 侧 getJwtSecret() 的结果一致（Edge Function 会用它校验
 * X-Internal-Call），因此这里复用同一个函数，包含「环境变量 -> KV 持久化
 * 随机密钥」的回退链。若两者不一致，代理鉴权会失败。
 */
async function getProxySecret(env?: EnvContext): Promise<string | null> {
  try {
    const { getJwtSecret } = await import("../../../server/middlewares")
    const secret = await getJwtSecret(env as any)
    return secret && secret.length >= 16 ? secret : null
  } catch {
    // 回退：仅环境变量
    const s = env?.JWT_SECRET || env?.ENCRYPTION_SECRET
    return typeof s === "string" && s.length >= 16 ? s : null
  }
}

/**
 * 构建 HTTP 代理请求头
 */
async function buildProxyHeaders(env?: EnvContext): Promise<HeadersInit> {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  }

  // 内部调用标识（使用密钥前 16 位，Edge Function 侧常量时间比对）
  const sharedSecret = await getProxySecret(env)
  if (sharedSecret) {
    headers["X-Internal-Call"] = sharedSecret.slice(0, 16)
  }

  // 如果有用户 token，也携带上（用于角色校验）
  const userToken = (env as any)?._currentUserToken
  if (userToken) {
    headers["Authorization"] = `Bearer ${userToken}`
  }

  return headers
}

/**
 * 获取 HTTP 代理基础 URL
 */
function getProxyBaseUrl(env?: EnvContext): string {
  if (!env) return ""
  
  // 允许通过环境变量覆盖
  if (env.EDGE_KV_BASE_URL) {
    return env.EDGE_KV_BASE_URL.replace(/\/$/, "")
  }
  
  // EdgeOne 内部调用：使用相对路径
  return ""
}

export const kvDriver: Driver = {
  name: "kv",

  async isAvailable(env?: any): Promise<boolean> {
    // 模式1: 检查 KV binding
    if (getKvBinding(env) !== null) {
      return true
    }
    
    // 模式2: 检查 HTTP 代理是否可用（EdgeOne Node Functions）
    if (isEdgeOneNodeEnv(env)) {
      try {
        const baseUrl = getProxyBaseUrl(env)
        const url = `${baseUrl}/kv-list?prefix=__health__`
        const response = await fetch(url, {
          method: "GET",
          headers: await buildProxyHeaders(env),
        })
        // 200 表示代理与 KV 均可用；401 表示代理存在但鉴权失败
        return response.ok || response.status === 401
      } catch {
        return false
      }
    }
    
    return false
  },

  async init(env?: any): Promise<void> {
    // KV 无需初始化
  },

  async get(key: string, env?: any): Promise<string | null> {
    const kv = getKvBinding(env)
    
    // 模式1: Binding 模式
    if (kv) {
      return await kv.get(key, "text")
    }
    
    // 模式2: HTTP 代理模式
    if (isEdgeOneNodeEnv(env)) {
      const baseUrl = getProxyBaseUrl(env)
      const url = `${baseUrl}/kv-get?key=${encodeURIComponent(key)}`
      
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: await buildProxyHeaders(env),
        })

        if (!response.ok) {
          if (response.status === 404) {
            return null
          }
          throw new Error(`KV proxy get failed: ${response.status}`)
        }

        const data = await response.json() as { value: string | null }
        return data.value
      } catch (err) {
        console.error(`[KV] get(${key}) failed:`, err)
        throw err
      }
    }
    
    throw new Error("KV binding not found")
  },

  async put(key: string, value: string, env?: any): Promise<void> {
    const kv = getKvBinding(env)
    
    // 模式1: Binding 模式
    if (kv) {
      await kv.put(key, value)
      return
    }
    
    // 模式2: HTTP 代理模式
    if (isEdgeOneNodeEnv(env)) {
      const baseUrl = getProxyBaseUrl(env)
      const url = `${baseUrl}/kv-put`
      
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: await buildProxyHeaders(env),
          body: JSON.stringify({ key, value }),
        })

        if (!response.ok) {
          throw new Error(`KV proxy put failed: ${response.status}`)
        }
      } catch (err) {
        console.error(`[KV] put(${key}) failed:`, err)
        throw err
      }
      return
    }
    
    throw new Error("KV binding not found")
  },

  async delete(key: string, env?: any): Promise<void> {
    const kv = getKvBinding(env)
    
    // 模式1: Binding 模式
    if (kv) {
      await kv.delete(key)
      return
    }
    
    // 模式2: HTTP 代理模式
    if (isEdgeOneNodeEnv(env)) {
      const baseUrl = getProxyBaseUrl(env)
      const url = `${baseUrl}/kv-delete?key=${encodeURIComponent(key)}`
      
      try {
        const response = await fetch(url, {
          method: "DELETE",
          headers: await buildProxyHeaders(env),
        })

        if (!response.ok && response.status !== 404) {
          throw new Error(`KV proxy delete failed: ${response.status}`)
        }
      } catch (err) {
        console.error(`[KV] delete(${key}) failed:`, err)
        throw err
      }
      return
    }
    
    throw new Error("KV binding not found")
  },

  async list(prefix: string, env?: any): Promise<string[]> {
    const kv = getKvBinding(env)
    
    // 模式1: Binding 模式
    if (kv) {
      // EdgeOne KV list() 语义（依据官方 functions-kv 示例）：
      //   page.keys -> [{ key, ttl, meta }]，page.complete 为 true 表示末页，
      //   下一页 cursor 需手动取本页最后一个 key。
      const keys: string[] = []
      let cursor = ""
      let complete = false
      let guard = 0

      while (!complete && guard < 1000) {
        guard += 1

        const page = await kv.list({ prefix, cursor, limit: 256 })
        const pageKeys = Array.isArray(page?.keys) ? page.keys : []

        for (const item of pageKeys) {
          if (item?.key) keys.push(item.key)
        }

        if (pageKeys.length > 0) {
          cursor = pageKeys[pageKeys.length - 1].key || ""
        }

        complete = Boolean(page?.complete) || pageKeys.length === 0
      }

      return keys
    }
    
    // 模式2: HTTP 代理模式
    if (isEdgeOneNodeEnv(env)) {
      const baseUrl = getProxyBaseUrl(env)
      const url = `${baseUrl}/kv-list?prefix=${encodeURIComponent(prefix)}`
      
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: await buildProxyHeaders(env),
        })

        if (!response.ok) {
          throw new Error(`KV proxy list failed: ${response.status}`)
        }

        const data = await response.json() as { keys: string[] }
        return data.keys || []
      } catch (err) {
        console.error(`[KV] list(${prefix}) failed:`, err)
        throw err
      }
    }
    
    throw new Error("KV binding not found")
  },

  async health(env?: any): Promise<any> {
    const kv = getKvBinding(env)
    
    // 模式1: Binding 模式
    if (kv) {
      try {
        await kv.get("__health_check__")
        return {
          driver: "kv",
          mode: "binding",
          available: true,
          platform: "Cloudflare KV / EdgeOne KV",
        }
      } catch (err: any) {
        return {
          driver: "kv",
          mode: "binding",
          available: false,
          error: err?.message || String(err),
        }
      }
    }
    
    // 模式2: HTTP 代理模式
    if (isEdgeOneNodeEnv(env)) {
      try {
        const baseUrl = getProxyBaseUrl(env)
        const url = `${baseUrl}/kv-list?prefix=__health__`
        
        const response = await fetch(url, {
          method: "GET",
          headers: await buildProxyHeaders(env),
        })

        if (!response.ok) {
          const text = await response.text()
          return {
            driver: "kv",
            mode: "proxy",
            available: false,
            error: `HTTP ${response.status}: ${text}`,
          }
        }

        return {
          driver: "kv",
          mode: "proxy",
          available: true,
          platform: "EdgeOne KV (via Edge Function proxy)",
        }
      } catch (err: any) {
        return {
          driver: "kv",
          mode: "proxy",
          available: false,
          error: err.message || String(err),
        }
      }
    }
    
    return {
      driver: "kv",
      mode: "unknown",
      available: false,
      error: "KV binding not found and not in EdgeOne Node environment",
    }
  },
}
