import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { hasSettingsManagerRights } from './access'

export type Role = 'admin' | 'user'
export interface AuthUser { username: string; role: Role; access_group?: string | null; access_group_label?: string | null; pages?: string[]; permissions?: string[] }
interface AuthContextValue {
  user: AuthUser | null
  token: string | null
  isLoading: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => void
  refreshUser: () => Promise<AuthUser | null>
  isAdmin: boolean
  isUserEquivalent: boolean
}

const TOKEN_KEY = 'vsm_auth_token'

function hasUserEquivalentRights(user: AuthUser | null): boolean {
  return hasSettingsManagerRights(user)
}

const AuthContext = createContext<AuthContextValue | null>(null)

const nativeFetch = window.fetch.bind(window)
window.fetch = (input: RequestInfo | URL, init: RequestInit = {}) => {
  const headers = new Headers(init.headers || {})
  const token = localStorage.getItem(TOKEN_KEY)
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  return nativeFetch(input, { ...init, headers })
}

async function readJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const error = new Error(data.detail || res.statusText) as Error & { status?: number; authInvalid?: boolean }
    error.status = res.status
    error.authInvalid = res.status === 401 || res.status === 403
    throw error
  }
  return data as T
}

function isAuthInvalidError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { authInvalid?: boolean }).authInvalid)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY))
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setLoading] = useState(Boolean(token))

  const refreshUser = useCallback(async (): Promise<AuthUser | null> => {
    if (!localStorage.getItem(TOKEN_KEY)) {
      setToken(null)
      setUser(null)
      return null
    }
    try {
      const data = await readJson<{ user: AuthUser }>(await fetch('/api/auth/me'))
      setUser(data.user)
      return data.user
    } catch (err) {
      if (isAuthInvalidError(err)) {
        localStorage.removeItem(TOKEN_KEY)
        setToken(null)
        setUser(null)
      }
      return null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function loadMe() {
      if (!token) {
        setUser(null)
        setLoading(false)
        return
      }
      setLoading(true)
      try {
        const data = await readJson<{ user: AuthUser }>(await fetch('/api/auth/me'))
        if (!cancelled) setUser(data.user)
      } catch (err) {
        if (isAuthInvalidError(err)) {
          localStorage.removeItem(TOKEN_KEY)
          if (!cancelled) {
            setToken(null)
            setUser(null)
          }
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    loadMe()
    return () => { cancelled = true }
  }, [token])

  useEffect(() => {
    if (!token) return undefined
    const refreshIfVisible = () => {
      if (document.visibilityState !== 'hidden') void refreshUser()
    }
    const interval = window.setInterval(refreshIfVisible, 60_000)
    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [refreshUser, token])

  const value = useMemo<AuthContextValue>(() => ({
    user,
    token,
    isLoading,
    isAdmin: user?.role === 'admin',
    isUserEquivalent: hasUserEquivalentRights(user),
    login: async (username: string, password: string) => {
      const controller = new AbortController()
      const timeout = window.setTimeout(() => controller.abort(), 45_000)
      try {
        const data = await readJson<{ token: string; user: AuthUser }>(await nativeFetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
          credentials: 'same-origin',
          signal: controller.signal,
        }))
        localStorage.setItem(TOKEN_KEY, data.token)
        setToken(data.token)
        setUser(data.user)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new Error('Сервер долго не отвечает. Попробуйте еще раз через несколько секунд')
        }
        throw err
      } finally {
        window.clearTimeout(timeout)
      }
    },
    logout: () => {
      localStorage.removeItem(TOKEN_KEY)
      setToken(null)
      setUser(null)
    },
    refreshUser,
  }), [isLoading, refreshUser, token, user])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// React refresh expects component-only exports from this mixed auth module.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

export function LoginScreen() {
  const { login, isLoading } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isSubmitting, setSubmitting] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (isSubmitting) return
    setError('')
    setSubmitting(true)
    try {
      await login(username, password)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const disabled = isSubmitting || isLoading

  if (isLoading) {
    return <div className="min-h-screen grid place-items-center text-sm text-text-muted">Проверка сессии...</div>
  }

  return (
    <div className="min-h-screen bg-bg-primary grid place-items-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-white border border-border rounded-lg shadow-sm p-5 space-y-4">
        <div>
          <h1 className="font-heading text-xl font-bold text-text-primary">Вход в VSM Dashboard</h1>
          <p className="text-sm text-text-muted mt-1">Доступы задаются через env.</p>
        </div>
        <label className="block">
          <span className="text-xs text-text-muted">Логин</span>
          <input
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoComplete="username"
            disabled={disabled}
            autoFocus
            className="mt-1 w-full border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-red"
          />
        </label>
        <label className="block">
          <span className="text-xs text-text-muted">Пароль</span>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="current-password"
            disabled={disabled}
            className="mt-1 w-full border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent-red"
          />
        </label>
        {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</div>}
        <button type="submit" disabled={disabled} className="w-full rounded-md bg-accent-red text-white text-sm font-semibold py-2 hover:bg-accent-burg disabled:cursor-wait disabled:opacity-70">
          {isSubmitting ? 'Входим...' : 'Войти'}
        </button>
      </form>
    </div>
  )
}
