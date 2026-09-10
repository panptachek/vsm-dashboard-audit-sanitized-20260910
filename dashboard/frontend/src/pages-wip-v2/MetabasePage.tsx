import { ExternalLink, RefreshCw } from 'lucide-react'

const METABASE_URL = '/metabase/'

export default function MetabasePage() {
  return (
    <section className="flex h-dvh flex-col bg-bg-primary">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-white px-5 py-3">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Metabase</h1>
          <p className="text-sm text-text-muted">BI-витрина подключена к рабочей БД только на чтение.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-sm font-medium text-text-secondary hover:bg-neutral-50"
          >
            <RefreshCw className="h-4 w-4" />
            Обновить
          </button>
          <a
            href={METABASE_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-md bg-accent-red px-3 py-2 text-sm font-medium text-white hover:bg-accent-red/90"
          >
            <ExternalLink className="h-4 w-4" />
            Открыть отдельно
          </a>
        </div>
      </header>
      <iframe
        title="Metabase"
        src={METABASE_URL}
        className="min-h-0 flex-1 border-0 bg-white"
        referrerPolicy="same-origin"
      />
    </section>
  )
}
