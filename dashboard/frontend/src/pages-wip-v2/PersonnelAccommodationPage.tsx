import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BedDouble,
  Building2,
  CalendarDays,
  Home,
  Hotel,
  Loader2,
  MapPin,
  Utensils,
  Users,
  X,
} from 'lucide-react'

interface AccommodationRow {
  id: string
  group_kind: 'hotels_apartments' | 'dorms_canteens'
  facility_type: 'hotel' | 'apartment' | 'dorm' | 'canteen'
  settlement?: string | null
  camp_name?: string | null
  section_label?: string | null
  facility_name: string
  address?: string | null
  places_total?: number | null
  places_base?: number | null
  places_actual?: number | null
  residents?: number | null
  free_places?: number | null
  itr_places_total?: number | null
  itr_places_occupied?: number | null
  canteen_people?: number | null
  canteen_seats_plan?: number | null
  canteen_seats_fact?: number | null
  note?: string | null
  sort_order?: number | null
}

interface AccommodationSummary {
  total_places: number
  total_residents: number
  total_free: number
  hotel_apartment_places: number
  hotel_apartment_residents: number
  hotel_apartment_free: number
  hotel_count: number
  apartment_count: number
  dorm_places: number
  dorm_residents: number
  dorm_free: number
  dorm_count: number
  canteen_people: number
  canteen_seats_fact: number
  canteen_seats_plan: number
  canteen_count: number
}

interface AccommodationGroupTotals {
  places: number
  residents: number
  free: number
  canteen_people: number
  canteen_seats_fact: number
  canteen_seats_plan: number
  items_count: number
}

interface SettlementGroup {
  settlement: string
  totals: AccommodationGroupTotals
  hotels_count: number
  apartments_count: number
  sections: string[]
  items: AccommodationRow[]
}

interface CampGroup {
  camp_name: string
  settlement: string
  totals: AccommodationGroupTotals
  dorms: AccommodationRow[]
  canteens: AccommodationRow[]
}

interface AccommodationPayload {
  ok: boolean
  detail?: string
  snapshot?: {
    id: string
    report_date: string
    source_filename?: string | null
    sheet_name?: string | null
    imported_at?: string | null
    imported_by?: string | null
    row_count: number
  }
  summary?: AccommodationSummary
  hotels_apartments?: {
    settlements: SettlementGroup[]
    items: AccommodationRow[]
  }
  dorms_canteens?: {
    camps: CampGroup[]
    dorms: AccommodationRow[]
    canteens: AccommodationRow[]
  }
}

interface DetailState {
  title: string
  subtitle?: string
  rows: AccommodationRow[]
}

interface FacilityCard {
  id: string
  facilityType: AccommodationRow['facility_type']
  label: string
  title: string
  subtitle: string
  detailTitle: string
  detailSubtitle: string
  rows: AccommodationRow[]
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error((data as { detail?: string }).detail || `HTTP ${response.status}`)
  }
  return data as T
}

function num(value: number | null | undefined): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function fmt(value: number | null | undefined): string {
  return num(value).toLocaleString('ru-RU', { maximumFractionDigits: 0 })
}

function fillPct(residents: number | null | undefined, places: number | null | undefined): number {
  const p = num(places)
  return p > 0 ? Math.min(100, Math.round(num(residents) / p * 100)) : 0
}

function rowKindLabel(row: AccommodationRow): string {
  if (row.facility_type === 'hotel') return 'Гостиница / хостел'
  if (row.facility_type === 'apartment') return 'Квартира'
  if (row.facility_type === 'dorm') return 'Общежитие'
  return 'Столовая'
}

function apartmentsCountLabel(count: number): string {
  const lastTwo = Math.abs(count) % 100
  const last = Math.abs(count) % 10
  if (lastTwo >= 11 && lastTwo <= 14) return `${count} квартир`
  if (last === 1) return `${count} квартира`
  if (last >= 2 && last <= 4) return `${count} квартиры`
  return `${count} квартир`
}

function detailRowsLabel(rows: AccommodationRow[]): string {
  const hotels = rows.filter(row => row.facility_type === 'hotel').length
  const apartments = rows.filter(row => row.facility_type === 'apartment').length
  const dorms = rows.filter(row => row.facility_type === 'dorm').length
  const canteens = rows.filter(row => row.facility_type === 'canteen').length
  return [
    hotels ? `гостиниц ${hotels}` : null,
    apartments ? `квартир ${apartments}` : null,
    dorms ? `общежитий ${dorms}` : null,
    canteens ? `столовых ${canteens}` : null,
  ].filter(Boolean).join(' · ')
}

function occupancySubtitle(residents: number, places: number, free?: number): string {
  return `${fmt(residents)} / ${fmt(places)} занято${free != null ? ` · свободно ${fmt(free)}` : ''}`
}

function MetricCard({
  title,
  value,
  subtitle,
  icon: Icon,
  tone,
  onClick,
}: {
  title: string
  value: string
  subtitle: string
  icon: typeof Users
  tone: 'red' | 'blue' | 'emerald' | 'amber' | 'slate'
  onClick: () => void
}) {
  const toneCls = {
    red: 'border-red-100 bg-red-50 text-accent-red',
    blue: 'border-blue-100 bg-blue-50 text-blue-700',
    emerald: 'border-emerald-100 bg-emerald-50 text-emerald-700',
    amber: 'border-amber-100 bg-amber-50 text-amber-700',
    slate: 'border-slate-200 bg-slate-50 text-slate-700',
  }[tone]
  return (
    <button
      type="button"
      onClick={onClick}
      className="group min-h-[118px] rounded-lg border border-border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-accent-red/30 hover:shadow-md"
    >
      <div className="flex items-start gap-3">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md border ${toneCls}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{title}</div>
          <div className="mt-1 font-heading text-3xl font-bold text-text-primary">{value}</div>
          <div className="mt-1 text-[12px] leading-snug text-text-secondary">{subtitle}</div>
        </div>
      </div>
    </button>
  )
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-bg-surface">
      <div className="h-full rounded-full bg-accent-red" style={{ width: `${percent}%` }} />
    </div>
  )
}

function SectionHeader({ title, meta }: { title: string; meta: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <h2 className="font-heading text-lg font-bold text-text-primary">{title}</h2>
      <div className="text-[12px] font-medium text-text-muted">{meta}</div>
    </div>
  )
}

function SettlementCard({ group, onOpen }: { group: SettlementGroup; onOpen: () => void }) {
  const percent = fillPct(group.totals.residents, group.totals.places)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="rounded-lg border border-border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-accent-red/30 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-text-muted">
            <MapPin className="h-3.5 w-3.5" />
            Населенный пункт
          </div>
          <div className="mt-1 truncate font-heading text-xl font-bold text-text-primary">{group.settlement}</div>
        </div>
        <div className="text-right text-[11px] text-text-muted">
          <div>{group.hotels_count} гост.</div>
          <div>{group.apartments_count} кв.</div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-[12px]">
        <Stat label="Мест" value={fmt(group.totals.places)} />
        <Stat label="Проживает" value={fmt(group.totals.residents)} />
        <Stat label="Свободно" value={fmt(group.totals.free)} />
      </div>
      <div className="mt-3">
        <ProgressBar percent={percent} />
        <div className="mt-1 text-[11px] font-medium text-text-muted">{percent}% занято</div>
      </div>
      {group.sections.length > 0 && (
        <div className="mt-3 text-[11px] text-text-muted">Участки: {group.sections.join(', ')}</div>
      )}
    </button>
  )
}

function CampCard({ group, onOpen }: { group: CampGroup; onOpen: () => void }) {
  const percent = fillPct(group.totals.residents, group.totals.places)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="rounded-lg border border-border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-accent-red/30 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-text-muted">
            <Building2 className="h-3.5 w-3.5" />
            Вахтовый поселок
          </div>
          <div className="mt-1 truncate font-heading text-xl font-bold text-text-primary">{group.camp_name}</div>
        </div>
        <div className="text-right text-[11px] text-text-muted">
          <div>{group.dorms.length} общ.</div>
          <div>{group.canteens.length} стол.</div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-[12px]">
        <Stat label="Мест" value={fmt(group.totals.places)} />
        <Stat label="Проживает" value={fmt(group.totals.residents)} />
        <Stat label="Свободно" value={fmt(group.totals.free)} />
      </div>
      <div className="mt-3">
        <ProgressBar percent={percent} />
        <div className="mt-1 text-[11px] font-medium text-text-muted">{percent}% занято</div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-text-muted">
        <div>Питается: <span className="font-semibold text-text-primary">{fmt(group.totals.canteen_people)}</span></div>
        <div>Мест столовых: <span className="font-semibold text-text-primary">{fmt(group.totals.canteen_seats_fact)}</span></div>
      </div>
    </button>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-bg-surface px-2 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-0.5 font-mono text-base font-bold text-text-primary">{value}</div>
    </div>
  )
}

function FacilityMiniCard({ card, onOpen }: { card: FacilityCard; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="rounded-lg border border-border bg-white p-3 text-left transition hover:border-accent-red/30 hover:shadow-sm"
    >
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
        {card.facilityType === 'apartment' ? <Home className="h-3.5 w-3.5" /> : card.facilityType === 'canteen' ? <Utensils className="h-3.5 w-3.5" /> : <Hotel className="h-3.5 w-3.5" />}
        {card.label}
      </div>
      <div className="mt-1 line-clamp-2 text-sm font-semibold text-text-primary">{card.title}</div>
      <div className="mt-1 text-[12px] text-text-muted">{card.subtitle}</div>
    </button>
  )
}

function DetailModal({ detail, onClose }: { detail: DetailState; onClose: () => void }) {
  const rows = [...detail.rows].sort((a, b) => num(a.sort_order) - num(b.sort_order))
  return (
    <div className="fixed inset-0 z-50 bg-black/35 p-3 sm:p-5" role="dialog" aria-modal="true">
      <div className="flex max-h-full flex-col rounded-lg border border-border bg-white shadow-xl">
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="font-heading text-lg font-bold text-text-primary">{detail.title}</div>
            {detail.subtitle && <div className="mt-0.5 text-[12px] text-text-muted">{detail.subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-surface hover:text-text-primary"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-auto p-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {rows.map(row => (
              <div key={row.id} className="rounded-lg border border-border bg-bg-surface/40 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    {row.facility_type !== 'apartment' && (
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">{rowKindLabel(row)}</div>
                    )}
                    <div className={`${row.facility_type === 'apartment' ? '' : 'mt-1'} text-sm font-bold leading-snug text-text-primary`}>
                      {row.facility_type === 'apartment' ? (row.address || row.facility_name) : row.facility_name}
                    </div>
                  </div>
                  {row.section_label && <div className="rounded bg-white px-2 py-1 text-[10px] font-semibold text-text-muted">Уч. {row.section_label}</div>}
                </div>
                {row.address && row.facility_type !== 'apartment' && <div className="mt-2 text-[12px] leading-snug text-text-secondary">{row.address}</div>}
                <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
                  {row.facility_type === 'canteen' ? (
                    <>
                      <Stat label="Питается" value={fmt(row.canteen_people)} />
                      <Stat label="Мест факт" value={fmt(row.canteen_seats_fact)} />
                      <Stat label="Мест план" value={fmt(row.canteen_seats_plan)} />
                    </>
                  ) : (
                    <>
                      <Stat label="Мест" value={fmt(row.places_total)} />
                      <Stat label="Проживает" value={fmt(row.residents)} />
                      <Stat label="Свободно" value={fmt(row.free_places)} />
                    </>
                  )}
                </div>
                {row.facility_type === 'dorm' && (
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                    <Stat label="Штатно" value={fmt(row.places_base)} />
                    <Stat label="ИТР занято" value={`${fmt(row.itr_places_occupied)} / ${fmt(row.itr_places_total)}`} />
                  </div>
                )}
                {row.note && <div className="mt-3 whitespace-pre-wrap rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">{row.note}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function PersonnelAccommodationPage() {
  const [detail, setDetail] = useState<DetailState | null>(null)
  const { data, isLoading, isError, error } = useQuery<AccommodationPayload>({
    queryKey: ['wip', 'personnel-accommodation'],
    queryFn: () => fetchJson<AccommodationPayload>('/api/wip/reports/personnel-accommodation'),
    staleTime: 60_000,
  })

  const summary = data?.summary
  const hotelItems = data?.hotels_apartments?.items ?? []
  const dormItems = data?.dorms_canteens?.dorms ?? []
  const canteenItems = data?.dorms_canteens?.canteens ?? []
  const allAccommodationRows = useMemo(() => [...hotelItems, ...dormItems], [hotelItems, dormItems])
  const facilityCards = useMemo<FacilityCard[]>(() => {
    const apartmentRows = hotelItems.filter(row => row.facility_type === 'apartment')
    const apartmentPlaces = apartmentRows.reduce((sum, row) => sum + num(row.places_total), 0)
    const apartmentResidents = apartmentRows.reduce((sum, row) => sum + num(row.residents), 0)
    const apartmentFree = apartmentRows.reduce((sum, row) => sum + num(row.free_places), 0)
    const apartmentCard: FacilityCard[] = apartmentRows.length > 0 ? [{
      id: 'apartments',
      facilityType: 'apartment',
      label: 'Квартиры',
      title: 'Квартиры',
      subtitle: `${apartmentsCountLabel(apartmentRows.length)} · ${occupancySubtitle(apartmentResidents, apartmentPlaces, apartmentFree)}`,
      detailTitle: 'Квартиры',
      detailSubtitle: occupancySubtitle(apartmentResidents, apartmentPlaces, apartmentFree),
      rows: apartmentRows,
    }] : []

    const rowCards = (rows: AccommodationRow[]): FacilityCard[] => rows.map(row => ({
      id: row.id,
      facilityType: row.facility_type,
      label: rowKindLabel(row),
      title: row.facility_name,
      subtitle: row.facility_type === 'canteen'
        ? `питается ${fmt(row.canteen_people)} · мест ${fmt(row.canteen_seats_fact)}`
        : occupancySubtitle(num(row.residents), num(row.places_total), num(row.free_places)),
      detailTitle: row.facility_name,
      detailSubtitle: row.address || row.camp_name || row.settlement || rowKindLabel(row),
      rows: [row],
    }))

    return [
      ...rowCards(hotelItems.filter(row => row.facility_type !== 'apartment')),
      ...apartmentCard,
      ...rowCards(dormItems),
      ...rowCards(canteenItems),
    ]
  }, [hotelItems, dormItems, canteenItems])

  function openDetail(title: string, rows: AccommodationRow[], subtitle?: string) {
    setDetail({ title, rows, subtitle: subtitle || detailRowsLabel(rows) })
  }

  return (
    <div className="min-h-full bg-bg-primary">
      <div className="border-b border-border bg-white px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <BedDouble className="h-5 w-5 text-accent-red" />
          <h1 className="mr-auto font-heading text-xl font-bold text-text-primary">Размещение персонала</h1>
          {data?.snapshot && (
            <div className="flex items-center gap-2 rounded-md border border-border bg-bg-surface px-3 py-1.5 text-[12px] text-text-secondary">
              <CalendarDays className="h-3.5 w-3.5" />
              {data.snapshot.report_date}
            </div>
          )}
        </div>
        {data?.snapshot && (
          <div className="mt-2 text-[12px] text-text-muted">
            {data.snapshot.source_filename || 'Отчет по гостиницам'} · строк {data.snapshot.row_count}
            {data.snapshot.imported_at ? ` · импорт ${new Date(data.snapshot.imported_at).toLocaleString('ru-RU')}` : ''}
          </div>
        )}
      </div>

      <div className="space-y-6 p-4 sm:p-6">
        {isLoading && (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => <div key={index} className="h-28 animate-pulse rounded-lg border border-border bg-white" />)}
          </div>
        )}

        {isError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-accent-red">
            {(error as Error).message}
          </div>
        )}

        {!isLoading && data && !data.ok && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {data.detail || 'Данные по размещению персонала еще не загружены.'}
          </div>
        )}

        {summary && data?.ok && (
          <>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
              <MetricCard
                title="Мест итого"
                value={fmt(summary.total_places)}
                subtitle={`свободно ${fmt(summary.total_free)}`}
                icon={BedDouble}
                tone="red"
                onClick={() => openDetail('Места размещения итого', allAccommodationRows, occupancySubtitle(summary.total_residents, summary.total_places, summary.total_free))}
              />
              <MetricCard
                title="Размещено итого"
                value={fmt(summary.total_residents)}
                subtitle={`${fillPct(summary.total_residents, summary.total_places)}% от мест`}
                icon={Users}
                tone="blue"
                onClick={() => openDetail('Размещено итого', allAccommodationRows, occupancySubtitle(summary.total_residents, summary.total_places, summary.total_free))}
              />
              <MetricCard
                title="Гостиницы и квартиры"
                value={fmt(summary.hotel_apartment_residents)}
                subtitle={`${fmt(summary.hotel_apartment_places)} мест · ${summary.hotel_count} гостиниц · ${summary.apartment_count} квартир`}
                icon={Hotel}
                tone="emerald"
                onClick={() => openDetail('Гостиницы и квартиры', hotelItems, occupancySubtitle(summary.hotel_apartment_residents, summary.hotel_apartment_places, summary.hotel_apartment_free))}
              />
              <MetricCard
                title="Общежития"
                value={fmt(summary.dorm_residents)}
                subtitle={`${fmt(summary.dorm_places)} мест · ${summary.dorm_count} объектов`}
                icon={Building2}
                tone="slate"
                onClick={() => openDetail('Общежития', dormItems, occupancySubtitle(summary.dorm_residents, summary.dorm_places, summary.dorm_free))}
              />
              <MetricCard
                title="Мест в столовых"
                value={fmt(summary.canteen_seats_fact)}
                subtitle={`план ${fmt(summary.canteen_seats_plan)} · столовых ${summary.canteen_count}`}
                icon={Utensils}
                tone="amber"
                onClick={() => openDetail('Столовые: посадочные места', canteenItems, `факт ${fmt(summary.canteen_seats_fact)} · план ${fmt(summary.canteen_seats_plan)}`)}
              />
              <MetricCard
                title="Питается в столовых"
                value={fmt(summary.canteen_people)}
                subtitle={`${summary.canteen_count} столовых`}
                icon={Users}
                tone="blue"
                onClick={() => openDetail('Питается в столовых', canteenItems, `людей питается ${fmt(summary.canteen_people)}`)}
              />
            </div>

            <section className="space-y-3">
              <SectionHeader
                title="Гостиницы и квартиры"
                meta={`${data.hotels_apartments?.settlements.length ?? 0} населенных пунктов · ${hotelItems.length} объектов`}
              />
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {(data.hotels_apartments?.settlements ?? []).map(group => (
                  <SettlementCard
                    key={group.settlement}
                    group={group}
                    onOpen={() => openDetail(group.settlement, group.items, occupancySubtitle(group.totals.residents, group.totals.places, group.totals.free))}
                  />
                ))}
              </div>
            </section>

            <section className="space-y-3">
              <SectionHeader
                title="Общежития и столовые"
                meta={`${data.dorms_canteens?.camps.length ?? 0} вахтовых поселка · ${summary.dorm_count} общежитий · ${summary.canteen_count} столовых`}
              />
              <div className="grid gap-3 lg:grid-cols-3">
                {(data.dorms_canteens?.camps ?? []).map(group => (
                  <CampCard
                    key={group.camp_name}
                    group={group}
                    onOpen={() => openDetail(group.camp_name, [...group.dorms, ...group.canteens], occupancySubtitle(group.totals.residents, group.totals.places, group.totals.free))}
                  />
                ))}
              </div>
            </section>

            <section className="space-y-3">
              <SectionHeader title="Объекты размещения" meta={`${facilityCards.length} карточек`} />
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {facilityCards.map(card => (
                  <FacilityMiniCard
                    key={card.id}
                    card={card}
                    onOpen={() => openDetail(card.detailTitle, card.rows, card.detailSubtitle)}
                  />
                ))}
              </div>
            </section>
          </>
        )}
      </div>

      {detail && <DetailModal detail={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}
