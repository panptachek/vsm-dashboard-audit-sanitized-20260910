import { Component, type ErrorInfo, type ReactNode } from 'react'

interface RouteErrorBoundaryProps {
  children: ReactNode
  resetKey?: string
}

interface RouteErrorBoundaryState {
  error: Error | null
}

const CHUNK_RELOAD_KEY = 'vsm_route_chunk_reload_once'

function isChunkLoadError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '')
  return /failed to fetch dynamically imported module|importing a module script failed|loading chunk|chunkloaderror|error loading dynamically imported module/i.test(message)
}

function reportRouteRenderError(error: Error, info: ErrorInfo) {
  fetch('/api/client-errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    keepalive: true,
    body: JSON.stringify({
      message: error.message,
      stack: error.stack || '',
      component_stack: info.componentStack || '',
      path: window.location.pathname + window.location.search,
      user_agent: window.navigator.userAgent,
    }),
  }).catch(() => undefined)
}

export class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  state: RouteErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): RouteErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Route render error', error, info)
    reportRouteRenderError(error, info)
    if (isChunkLoadError(error) && sessionStorage.getItem(CHUNK_RELOAD_KEY) !== '1') {
      sessionStorage.setItem(CHUNK_RELOAD_KEY, '1')
      window.location.reload()
    }
  }

  componentDidUpdate(prevProps: RouteErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  render() {
    if (!this.state.error) return this.props.children

    const chunkError = isChunkLoadError(this.state.error)

    return (
      <div className="min-h-dvh bg-bg-primary p-4 sm:p-8">
        <div className="mx-auto max-w-xl rounded-lg border border-border bg-white p-5 shadow-sm">
          <div className="font-heading text-lg font-bold text-text-primary">Страница не загрузилась</div>
          <p className="mt-2 text-sm leading-6 text-text-muted">
            {chunkError
              ? 'Браузер получил устаревший файл страницы. Обнови страницу, чтобы подтянуть свежую сборку.'
              : 'Во время отрисовки страницы произошла ошибка. Обнови страницу; если повторится, нужно смотреть консоль браузера.'}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 inline-flex h-9 items-center justify-center rounded-md bg-accent-red px-4 text-sm font-semibold text-white hover:bg-accent-burg"
          >
            Обновить
          </button>
        </div>
      </div>
    )
  }
}
