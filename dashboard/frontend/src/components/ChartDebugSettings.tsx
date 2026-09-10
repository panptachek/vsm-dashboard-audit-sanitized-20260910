import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, RotateCcw, Save, Settings, X } from 'lucide-react'
import { useAuth } from '../auth'

export interface ChartDebugFilters {
  materials?: string[]
  movement_types?: string[]
  source_buckets?: string[]
  source_kinds?: string[]
  source_object_type_codes?: string[]
  source_object_ids?: string[]
  tags?: string[]
  object_type_codes?: string[]
  object_codes?: string[]
  equipment_classes?: string[]
}

interface DebugOption {
  value: string
  label: string
  hint?: string | null
}

interface DebugOptionsResponse {
  materials?: DebugOption[]
  movement_types?: DebugOption[]
  source_buckets?: DebugOption[]
  source_kinds?: DebugOption[]
  source_object_type_codes?: DebugOption[]
  source_object_ids?: DebugOption[]
  tags?: DebugOption[]
  object_type_codes?: DebugOption[]
  object_codes?: DebugOption[]
  equipment_classes?: DebugOption[]
}

interface DebugConfigResponse {
  key: string
  filters: ChartDebugFilters
  updated_by?: string | null
  updated_at?: string | null
}

const FILTER_KEYS: Array<keyof ChartDebugFilters> = [
  'materials',
  'movement_types',
  'source_buckets',
  'source_kinds',
  'source_object_type_codes',
  'source_object_ids',
  'tags',
  'object_type_codes',
  'object_codes',
  'equipment_classes',
]

const FILTER_LABELS: Record<keyof ChartDebugFilters, string> = {
  materials: 'Материалы',
  movement_types: 'Направления перевозок',
  source_buckets: 'Чьими силами',
  source_kinds: 'Тип источника',
  source_object_type_codes: 'Типы объектов-источников',
  source_object_ids: 'Объекты-источники',
  tags: 'Теги работ',
  object_type_codes: 'Типы объектов работ',
  object_codes: 'Объекты работ',
  equipment_classes: 'Типы техники',
}

const EMPTY_FILTERS: ChartDebugFilters = Object.fromEntries(FILTER_KEYS.map(key => [key, []])) as ChartDebugFilters

export function normalizeChartDebugFilters(filters?: ChartDebugFilters | null): ChartDebugFilters {
  const src = filters || {}
  return Object.fromEntries(FILTER_KEYS.map(key => [key, Array.isArray(src[key]) ? [...(src[key] || [])] : []])) as ChartDebugFilters
}

export function hasChartDebugFilters(filters?: ChartDebugFilters | null): boolean {
  const normalized = normalizeChartDebugFilters(filters)
  return FILTER_KEYS.some(key => (normalized[key] || []).length > 0)
}

export function selectedFilterValues(filters: ChartDebugFilters | null | undefined, key: keyof ChartDebugFilters): string[] {
  const values = normalizeChartDebugFilters(filters)[key]
  return Array.isArray(values) ? values : []
}

function filterCount(filters?: ChartDebugFilters | null): number {
  const normalized = normalizeChartDebugFilters(filters)
  return FILTER_KEYS.reduce((sum, key) => sum + (normalized[key]?.length || 0), 0)
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.detail || body.message || res.statusText)
  return body as T
}

export function ChartDebugControl({
  configKey,
  title,
  from,
  to,
  onChange,
  compact = false,
}: {
  configKey: string
  title: string
  from?: string
  to?: string
  onChange?: (filters: ChartDebugFilters) => void
  compact?: boolean
}) {
  const { isAdmin } = useAuth()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<ChartDebugFilters>(EMPTY_FILTERS)
  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  const optionsUrl = `/api/wip/dashboard-debug/options${params.toString() ? `?${params}` : ''}`

  const { data: options, isLoading: optionsLoading } = useQuery<DebugOptionsResponse>({
    queryKey: ['wip', 'dashboard-debug', 'options', from || '', to || ''],
    queryFn: () => fetchJson<DebugOptionsResponse>(optionsUrl),
    enabled: isAdmin,
    staleTime: 120_000,
  })

  const { data: config, isLoading: configLoading } = useQuery<DebugConfigResponse>({
    queryKey: ['wip', 'dashboard-debug', 'config', configKey],
    queryFn: () => fetchJson<DebugConfigResponse>(`/api/wip/dashboard-debug/config?key=${encodeURIComponent(configKey)}`),
    enabled: isAdmin,
    staleTime: 60_000,
  })

  useEffect(() => {
    if (!isAdmin) return
    const filters = normalizeChartDebugFilters(config?.filters)
    setDraft(filters)
    onChange?.(filters)
  }, [config?.filters, isAdmin, onChange])

  const saveMutation = useMutation({
    mutationFn: () => fetchJson<DebugConfigResponse>('/api/wip/dashboard-debug/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: configKey, filters: draft }),
    }),
    onSuccess: body => {
      qc.setQueryData(['wip', 'dashboard-debug', 'config', configKey], body)
      onChange?.(normalizeChartDebugFilters(body.filters))
      setOpen(false)
    },
  })

  const activeCount = filterCount(config?.filters)
  const dirty = JSON.stringify(normalizeChartDebugFilters(config?.filters)) !== JSON.stringify(normalizeChartDebugFilters(draft))

  if (!isAdmin) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`relative inline-flex items-center justify-center rounded-md border border-border bg-white text-text-muted shadow-sm hover:border-accent-red/40 hover:text-accent-red ${compact ? 'h-8 w-8' : 'h-8 gap-1.5 px-2.5 text-xs font-semibold'}`}
        title="Отладка данных графика"
        aria-label="Отладка данных графика"
      >
        <Settings className="h-4 w-4" />
        {!compact && <span>Данные</span>}
        {activeCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-red px-1 text-[10px] font-bold leading-none text-white">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/45 p-3">
          <div className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-border bg-white shadow-xl">
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <Settings className="h-4 w-4 text-accent-red" />
              <div className="min-w-0 flex-1">
                <div className="font-heading text-sm font-semibold text-text-primary">Отладка данных: {title}</div>
                <div className="text-[11px] text-text-muted">
                  Выбор пустой - используется стандартная логика блока. Настройка видна только администраторам.
                  {config?.updated_by ? ` Последнее изменение: ${config.updated_by}` : ''}
                </div>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded p-1.5 text-text-muted hover:bg-bg-surface hover:text-text-primary" aria-label="Закрыть">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-4">
              {optionsLoading || configLoading ? (
                <div className="flex h-48 items-center justify-center text-sm text-text-muted">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Загрузка справочников
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
                  <OptionGroup title={FILTER_LABELS.materials} options={options?.materials || []} values={draft.materials || []} onChange={values => setDraft(prev => ({ ...prev, materials: values }))} />
                  <OptionGroup title={FILTER_LABELS.movement_types} options={options?.movement_types || []} values={draft.movement_types || []} onChange={values => setDraft(prev => ({ ...prev, movement_types: values }))} />
                  <OptionGroup title={FILTER_LABELS.source_buckets} options={options?.source_buckets || []} values={draft.source_buckets || []} onChange={values => setDraft(prev => ({ ...prev, source_buckets: values }))} />
                  <OptionGroup title={FILTER_LABELS.source_kinds} options={options?.source_kinds || []} values={draft.source_kinds || []} onChange={values => setDraft(prev => ({ ...prev, source_kinds: values }))} />
                  <OptionGroup title={FILTER_LABELS.source_object_type_codes} options={options?.source_object_type_codes || []} values={draft.source_object_type_codes || []} onChange={values => setDraft(prev => ({ ...prev, source_object_type_codes: values }))} />
                  <OptionGroup title={FILTER_LABELS.source_object_ids} options={options?.source_object_ids || []} values={draft.source_object_ids || []} onChange={values => setDraft(prev => ({ ...prev, source_object_ids: values }))} searchable />
                  <OptionGroup title={FILTER_LABELS.tags} options={options?.tags || []} values={draft.tags || []} onChange={values => setDraft(prev => ({ ...prev, tags: values }))} searchable />
                  <OptionGroup title={FILTER_LABELS.object_type_codes} options={options?.object_type_codes || []} values={draft.object_type_codes || []} onChange={values => setDraft(prev => ({ ...prev, object_type_codes: values }))} />
                  <OptionGroup title={FILTER_LABELS.object_codes} options={options?.object_codes || []} values={draft.object_codes || []} onChange={values => setDraft(prev => ({ ...prev, object_codes: values }))} searchable />
                  <OptionGroup title={FILTER_LABELS.equipment_classes} options={options?.equipment_classes || []} values={draft.equipment_classes || []} onChange={values => setDraft(prev => ({ ...prev, equipment_classes: values }))} />
                </div>
              )}
              {saveMutation.error && <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{saveMutation.error.message}</div>}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
              <button
                type="button"
                onClick={() => setDraft(EMPTY_FILTERS)}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-white px-3 text-xs font-semibold text-text-muted hover:text-text-primary"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Очистить выбор
              </button>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setOpen(false)} className="h-8 rounded-md border border-border bg-white px-3 text-xs font-semibold text-text-muted hover:text-text-primary">
                  Отмена
                </button>
                <button
                  type="button"
                  disabled={!dirty || saveMutation.isPending}
                  onClick={() => saveMutation.mutate()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent-red px-3 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {saveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  Сохранить
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function OptionGroup({ title, options, values, onChange, searchable = false }: {
  title: string
  options: DebugOption[]
  values: string[]
  onChange: (values: string[]) => void
  searchable?: boolean
}) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options.slice(0, 160)
    return options.filter(option => `${option.label} ${option.hint || ''}`.toLowerCase().includes(q)).slice(0, 160)
  }, [options, query])

  function toggle(value: string) {
    onChange(values.includes(value) ? values.filter(item => item !== value) : [...values, value])
  }

  return (
    <div className="rounded-lg border border-border bg-bg-surface/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-text-primary">{title}</div>
        <button type="button" onClick={() => onChange([])} className="text-[10px] font-semibold text-text-muted hover:text-accent-red">сброс</button>
      </div>
      {searchable && (
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Поиск"
          className="mb-2 h-8 w-full rounded-md border border-border bg-white px-2 text-xs text-text-primary outline-none focus:border-accent-red/50"
        />
      )}
      <div className="max-h-52 space-y-1 overflow-auto pr-1">
        {filtered.length === 0 ? (
          <div className="rounded border border-dashed border-border bg-white px-2 py-4 text-center text-xs text-text-muted">Нет значений</div>
        ) : filtered.map(option => (
          <label key={option.value} className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-white px-2 py-1.5 text-xs hover:border-accent-red/30">
            <input type="checkbox" checked={values.includes(option.value)} onChange={() => toggle(option.value)} className="mt-0.5" />
            <span className="min-w-0">
              <span className="block text-text-primary">{option.label}</span>
              {option.hint && <span className="block truncate text-[10px] text-text-muted" title={option.hint}>{option.hint}</span>}
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}
