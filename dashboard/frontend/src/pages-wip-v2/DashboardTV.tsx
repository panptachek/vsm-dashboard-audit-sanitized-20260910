import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchDashboardTv } from '../api/dashboardTv';
import type {
  DashboardPeriod,
  DashboardTvResponse,
  DashboardTvSection,
  EquipmentAlert,
  PileDynamicsSection,
} from '../types/dashboardTv';
import { clampPercent, dateRangeLabel, formatM3, formatNumber, formatPercent } from '../utils/dashboardFormat';
import './dashboardTvChampionship.css';

const SCREEN_DURATION_MS = 15000;
const REFRESH_INTERVAL_MS = 90000;
const PERIODS: DashboardPeriod[] = ['day', 'week'];
const TAG_COLORS = ['#f7c948', '#2fd17c', '#4aa8ff', '#b084ff', '#ff7b72'];

type ScreenId = 'sand-haul' | 'sand-placement' | 'equipment' | 'piles';

type ScreenDefinition = {
  id: ScreenId;
  title: string;
  label: string;
  eyebrow: string;
};

const SCREENS: ScreenDefinition[] = [
  { id: 'sand-haul', title: 'Завоз песка с карьеров', label: 'Завоз', eyebrow: 'По участкам и доле ЖДС' },
  { id: 'sand-placement', title: 'Укладка песка в конструктивы', label: 'Укладка', eyebrow: 'Работы с аналитическим тегом «Песок»' },
  { id: 'equipment', title: 'Использование техники', label: 'Техника', eyebrow: 'Средний коэффициент по участкам' },
  { id: 'piles', title: 'Забитые сваи по участкам', label: 'Сваи', eyebrow: 'Основные и пробные сваи' },
];

const PERIOD_LABEL: Record<DashboardPeriod, string> = {
  day: 'Прошедший день',
  week: 'Календарная неделя',
};

function cssVars(values: Record<string, string | number | undefined>): CSSProperties {
  return values as CSSProperties;
}

function sectionStyle(section: Pick<DashboardTvSection, 'color'> | Pick<PileDynamicsSection, 'color'> | EquipmentAlert): CSSProperties {
  return cssVars({ '--section-color': section.color ?? '#4aa8ff' });
}

function maxValue(values: number[]): number {
  return Math.max(1, ...values.map((value) => (Number.isFinite(value) ? value : 0)));
}

function barPercent(value: number, max: number, min = 4): number {
  if (!value || !max) return 0;
  return Math.max(min, Math.min(100, (value / max) * 100));
}

function shortSection(section: Pick<DashboardTvSection, 'sectionNumber' | 'sectionCode'>): string {
  return section.sectionNumber ? `Уч. ${section.sectionNumber}` : section.sectionCode.replace('UCH_', 'Уч. ');
}

function reinforcementLabel(section: Pick<DashboardTvSection, 'sectionNumber' | 'sectionName'> | PileDynamicsSection): string {
  const sectionNumber = 'sectionNumber' in section ? section.sectionNumber : Number(section.sectionCode.replace(/\D/g, ''));
  return sectionNumber ? `Участок усиления ${sectionNumber}` : section.sectionName;
}

function signed(value: number): string {
  if (value > 0) return `+${formatNumber(value, 0)}`;
  return formatNumber(value, 0);
}

function periodDate(data: DashboardTvResponse): string {
  return dateRangeLabel(data.periodStart, data.periodEnd);
}

function shortDate(value?: string | null): string {
  if (!value) return 'нет даты';
  return value.slice(0, 10);
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'amber' | 'green' | 'blue' | 'red' }) {
  return (
    <div className={`tv-metric ${tone ? `is-${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DashboardState({ title, detail, onRetry }: { title: string; detail?: string; onRetry?: () => void }) {
  return (
    <main className="vsm-tv-dashboard">
      <div className="dashboard-state">
        <h1>{title}</h1>
        {detail && <p>{detail}</p>}
        {onRetry && <button type="button" onClick={onRetry}>Повторить</button>}
      </div>
    </main>
  );
}

function TvHeader({
  data,
  screen,
  screenIndex,
  period,
  onPeriodChange,
  onScreenChange,
}: {
  data: DashboardTvResponse;
  screen: ScreenDefinition;
  screenIndex: number;
  period: DashboardPeriod;
  onPeriodChange: (period: DashboardPeriod) => void;
  onScreenChange: (index: number) => void;
}) {
  return (
    <header className="tv-topbar">
      <div className="tv-title-block">
        <div className="tv-eyebrow">{screen.eyebrow}</div>
        <h1>{screen.title}</h1>
        <div className="tv-date-line">
          <span>{PERIOD_LABEL[period]}</span>
          <strong>{periodDate(data)}</strong>
        </div>
      </div>

      <div className="tv-control-block">
        <div className="period-switch" aria-label="Отчетный период">
          {PERIODS.map((item) => (
            <button
              type="button"
              key={item}
              className={period === item ? 'is-active' : ''}
              onClick={() => onPeriodChange(item)}
            >
              {item === 'day' ? 'День' : 'Неделя'}
            </button>
          ))}
        </div>
        <div className="screen-tabs" aria-label="Экраны дашборда">
          {SCREENS.map((item, index) => (
            <button
              type="button"
              key={item.id}
              className={screenIndex === index ? 'is-active' : ''}
              onClick={() => onScreenChange(index)}
              title={item.title}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="data-pill">
          <span>Данные БД</span>
          <strong>{shortDate(data.updatedAt ?? data.periodEnd)}</strong>
        </div>
      </div>
    </header>
  );
}

function SandHaulScreen({ data }: { data: DashboardTvResponse }) {
  const maxSand = data.totals.maxSandQuarryM3 || maxValue(data.sections.map((section) => section.sandQuarry.totalM3));
  const jdsShare = data.totals.sandQuarryM3 > 0 ? (data.totals.sandQuarryJdsM3 / data.totals.sandQuarryM3) * 100 : 0;
  const totalTrips = data.sections.reduce((sum, section) => sum + section.sandQuarry.trips, 0);

  return (
    <section className="tv-screen sand-haul-screen">
      <div className="tv-summary-grid is-four">
        <Metric label="Завезено с карьеров" value={formatM3(data.totals.sandQuarryM3, 0)} tone="amber" />
        <Metric label="Выполнено ЖДС" value={formatM3(data.totals.sandQuarryJdsM3, 0)} tone="green" />
        <Metric label="Доля ЖДС" value={formatPercent(jdsShare, 0)} tone="blue" />
        <Metric label="Рейсы" value={formatNumber(totalTrips, 0)} />
      </div>

      <div className="haul-board">
        {data.sections.map((section) => {
          const total = section.sandQuarry.totalM3;
          const jds = section.sandQuarry.jdsM3;
          const totalWidth = barPercent(total, maxSand, 0);
          const jdsWidth = total > 0 ? clampPercent((jds / total) * 100) : 0;
          return (
            <article className="haul-row-card" key={section.sectionCode} style={sectionStyle(section)}>
              <div className="section-chip is-compact">
                <span>{shortSection(section)}</span>
                <strong>{section.sectionName}</strong>
              </div>
              <div className="haul-main-value">
                <strong>{formatM3(total, 0)}</strong>
                <span>{formatNumber(section.sandQuarry.trips, 0)} рейсов</span>
              </div>
              <div className="haul-track" aria-label="Объем завоза и доля ЖДС">
                <i className="haul-track__total" style={{ width: `${totalWidth}%` }} />
                <i className="haul-track__jds" style={{ width: `${jdsWidth}%` }} />
              </div>
              <div className="haul-split">
                <div><span>ЖДС</span><b>{formatM3(jds, 0)}</b></div>
                <div><span>Прочие</span><b>{formatM3(section.sandQuarry.otherM3, 0)}</b></div>
              </div>
              <div className="quarry-list is-inline">
                {section.sandQuarry.quarries.length ? section.sandQuarry.quarries.slice(0, 3).map((quarry) => (
                  <div key={quarry.name}>
                    <span>{quarry.name}</span>
                    <b>{formatM3(quarry.volumeM3, 0)}</b>
                  </div>
                )) : <em>завоза нет</em>}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function TagBreakdown({ section, maxPlaced }: { section: DashboardTvSection; maxPlaced: number }) {
  const total = section.sandPlaced.totalM3;
  return (
    <article className="placement-tile" style={sectionStyle(section)}>
      <div className="section-chip is-compact">
        <span>{shortSection(section)}</span>
        <strong>{section.sectionName}</strong>
      </div>
      <div className="placement-total">
        <strong>{formatM3(total, 0)}</strong>
        <div className="placement-total__bar">
          <i style={{ width: `${barPercent(total, maxPlaced, 0)}%` }} />
        </div>
      </div>
      <div className="tag-stack">
        {section.sandPlaced.byTag.length ? section.sandPlaced.byTag.slice(0, 4).map((tag, index) => {
          const width = total > 0 ? clampPercent((tag.volume / total) * 100) : 0;
          return (
            <div className="tag-row" key={`${tag.tag}-${tag.unit}`}>
              <span>{tag.tag}</span>
              <b>{formatNumber(tag.volume, 0)} {tag.unit}</b>
              <i style={{ width: `${width}%`, background: TAG_COLORS[index % TAG_COLORS.length] }} />
            </div>
          );
        }) : <em>работ с песком нет</em>}
      </div>
    </article>
  );
}

function SandPlacementScreen({ data }: { data: DashboardTvResponse }) {
  const maxPlaced = data.totals.maxSandPlacedM3 || maxValue(data.sections.map((section) => section.sandPlaced.totalM3));
  const tagTotals = new Map<string, number>();
  data.sections.forEach((section) => {
    section.sandPlaced.byTag.forEach((tag) => tagTotals.set(tag.tag, (tagTotals.get(tag.tag) ?? 0) + tag.volume));
  });
  const topTags = Array.from(tagTotals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4);

  return (
    <section className="tv-screen placement-screen">
      <div className="tv-summary-grid is-wide">
        <Metric label="Уложено в конструктивы" value={formatM3(data.totals.sandPlacedM3, 0)} tone="amber" />
        {topTags.map(([tag, value], index) => (
          <Metric key={tag} label={tag} value={formatM3(value, 0)} tone={index === 0 ? 'green' : 'blue'} />
        ))}
      </div>
      <div className="placement-grid">
        {data.sections.map((section) => <TagBreakdown key={section.sectionCode} section={section} maxPlaced={maxPlaced} />)}
      </div>
    </section>
  );
}

function equipmentTone(percent: number | null): string {
  if (percent === null) return 'is-empty';
  if (percent < 40) return 'is-low';
  if (percent > 100) return 'is-high';
  return 'is-normal';
}

function EquipmentScreen({ data }: { data: DashboardTvResponse }) {
  const alerts = data.equipmentAlerts.slice(0, 12);
  return (
    <section className="tv-screen equipment-screen">
      <div className="equipment-board">
        {data.sections.map((section) => {
          const pct = section.equipment.utilizationPct;
          return (
            <article className={`equipment-tile ${equipmentTone(pct)}`} key={section.sectionCode} style={sectionStyle(section)}>
              <div className="section-chip is-compact">
                <span>{shortSection(section)}</span>
                <strong>{section.sectionName}</strong>
              </div>
              <div className="equipment-score">
                <strong>{pct === null ? '—' : formatPercent(pct, 0)}</strong>
                <span>{section.equipment.activeUnits}/{section.equipment.totalUnits} ед. в работе</span>
              </div>
              <div className="equipment-ring" style={cssVars({ '--score': `${clampPercent(pct ?? 0)}%` })}>
                <i />
              </div>
              <div className="equipment-cats">
                {section.equipment.categories.length ? section.equipment.categories.slice(0, 3).map((category) => (
                  <div key={category.equipmentType}>
                    <span>{category.label}</span>
                    <b>{formatPercent(category.percent, 0)}</b>
                  </div>
                )) : <em>нет нормируемой выработки</em>}
              </div>
            </article>
          );
        })}
      </div>

      <div className="alerts-panel">
        <div className="alerts-title">
          <span>Отклонения по отдельным категориям</span>
          <strong>{alerts.length ? `${alerts.length} позиций` : 'нет отклонений'}</strong>
        </div>
        <div className="alerts-grid">
          {alerts.length ? alerts.map((alert) => <EquipmentAlertCard key={`${alert.sectionCode}-${alert.label}-${alert.percent}`} alert={alert} />) : (
            <div className="empty-alert">Категорий ниже 40% или выше 100% за период нет.</div>
          )}
        </div>
      </div>
    </section>
  );
}

function EquipmentAlertCard({ alert }: { alert: EquipmentAlert }) {
  return (
    <article className={`alert-card is-${alert.severity}`} style={sectionStyle(alert)}>
      <div>
        <span>{alert.sectionName}</span>
        <strong>{alert.label}</strong>
      </div>
      <b>{formatPercent(alert.percent, 0)}</b>
    </article>
  );
}

function PilePie({ sections }: { sections: DashboardTvSection[] }) {
  const total = sections.reduce((sum, section) => sum + section.piles.total, 0);
  let offset = 0;
  const segments = sections
    .filter((section) => section.piles.total > 0)
    .map((section) => {
      const percent = total > 0 ? (section.piles.total / total) * 100 : 0;
      const segment = { section, percent, offset };
      offset += percent;
      return segment;
    });

  return (
    <div className="pile-pie-wrap">
      <svg className="pile-pie" viewBox="0 0 120 120" role="img" aria-label="Круговая диаграмма свай по участкам">
        <circle className="pile-pie__track" cx="60" cy="60" r="46" pathLength="100" />
        {segments.map(({ section, percent, offset: dashOffset }) => (
          <circle
            key={section.sectionCode}
            className="pile-pie__section"
            cx="60"
            cy="60"
            r="46"
            pathLength="100"
            stroke={section.color ?? '#4aa8ff'}
            strokeDasharray={`${percent} ${100 - percent}`}
            strokeDashoffset={-dashOffset}
          />
        ))}
      </svg>
      <div className="pile-pie-center">
        <span>Всего свай</span>
        <strong>{formatNumber(total, 0)}</strong>
      </div>
    </div>
  );
}

function PilesScreen({ data }: { data: DashboardTvResponse }) {
  const maxPiles = data.totals.maxPileTotal || maxValue(data.sections.map((section) => section.piles.total));
  const activeDynamics = data.pileDynamics.sections.filter((section) => section.current > 0 || section.previous > 0);
  const dynamics = (activeDynamics.length ? activeDynamics : data.pileDynamics.sections).slice(0, 8);

  return (
    <section className="tv-screen piles-screen">
      <div className="piles-main-panel">
        <PilePie sections={data.sections} />
        <div className="pile-legend">
          <div><i className="is-main" /><span>Основные сваи</span><strong>{formatNumber(data.totals.pileMain, 0)}</strong></div>
          <div><i className="is-trial" /><span>Пробные сваи</span><strong>{formatNumber(data.totals.pileTrial, 0)}</strong></div>
        </div>
      </div>

      <div className="pile-section-grid">
        {data.sections.map((section) => {
          const width = barPercent(section.piles.total, maxPiles, 0);
          return (
            <article className="pile-section-row" key={section.sectionCode} style={sectionStyle(section)}>
              <span>{shortSection(section)}</span>
              <div>
                <strong>{formatNumber(section.piles.total, 0)} свай</strong>
                <small>осн. {formatNumber(section.piles.main, 0)} / проб. {formatNumber(section.piles.trial, 0)}</small>
                <i style={{ width: `${width}%` }} />
              </div>
            </article>
          );
        })}
      </div>

      <aside className="pile-dynamics-panel">
        <div className="dynamics-title">
          <span>Динамика за два дня</span>
          <strong>{data.pileDynamics.previousDate} → {data.pileDynamics.currentDate}</strong>
        </div>
        <div className="dynamics-list">
          {dynamics.map((section) => (
            <article className="dynamic-row" key={section.sectionCode} style={sectionStyle(section)}>
              <div>
                <span>{reinforcementLabel(section)}</span>
                <strong>{formatNumber(section.current, 0)} свай</strong>
              </div>
              <div>
                <small>было {formatNumber(section.previous, 0)}</small>
                <b className={section.delta >= 0 ? 'is-up' : 'is-down'}>{signed(section.delta)}</b>
              </div>
            </article>
          ))}
        </div>
      </aside>
    </section>
  );
}

function ActiveScreen({ data, screen }: { data: DashboardTvResponse; screen: ScreenDefinition }) {
  if (screen.id === 'sand-haul') return <SandHaulScreen data={data} />;
  if (screen.id === 'sand-placement') return <SandPlacementScreen data={data} />;
  if (screen.id === 'equipment') return <EquipmentScreen data={data} />;
  return <PilesScreen data={data} />;
}

export default function DashboardTV() {
  const [period, setPeriod] = useState<DashboardPeriod>('day');
  const [screenIndex, setScreenIndex] = useState(0);
  const [cache, setCache] = useState<Record<DashboardPeriod, DashboardTvResponse | null>>({ day: null, week: null });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDashboard = useCallback(async (signal?: AbortSignal) => {
    setIsLoading(true);
    try {
      const [day, week] = await Promise.all(PERIODS.map((item) => fetchDashboardTv({ period: item, signal })));
      setCache({ day, week });
      setError(null);
    } catch (err) {
      if (!signal?.aborted) setError((err as Error).message);
    } finally {
      if (!signal?.aborted) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadDashboard(controller.signal);
    const refreshId = window.setInterval(() => void loadDashboard(), REFRESH_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(refreshId);
    };
  }, [loadDashboard]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setScreenIndex((current) => {
        if (current >= SCREENS.length - 1) {
          setPeriod((previous) => (previous === 'day' ? 'week' : 'day'));
          return 0;
        }
        return current + 1;
      });
    }, SCREEN_DURATION_MS);
    return () => window.clearInterval(timer);
  }, []);

  const activeScreen = SCREENS[screenIndex] ?? SCREENS[0];
  const data = cache[period];
  const fallbackData = useMemo(() => cache.day ?? cache.week, [cache.day, cache.week]);

  function selectPeriod(next: DashboardPeriod) {
    setPeriod(next);
    setScreenIndex(0);
  }

  if (!data && isLoading && !fallbackData) {
    return <DashboardState title="Загрузка дашборда" detail="Собираем день и неделю из базы данных." />;
  }

  if (!data && error && !fallbackData) {
    return <DashboardState title="Дашборд недоступен" detail={error} onRetry={() => void loadDashboard()} />;
  }

  const visibleData = data ?? fallbackData;
  if (!visibleData) {
    return <DashboardState title="Нет данных" detail="Подтвержденные факты для TV-дашборда не найдены." onRetry={() => void loadDashboard()} />;
  }

  return (
    <main className="vsm-tv-dashboard">
      <div className="tv-shell">
        <TvHeader
          data={visibleData}
          screen={activeScreen}
          screenIndex={screenIndex}
          period={period}
          onPeriodChange={selectPeriod}
          onScreenChange={setScreenIndex}
        />
        {visibleData.sourceDateNote && <div className="source-note">{visibleData.sourceDateNote}</div>}
        <ActiveScreen data={visibleData} screen={activeScreen} />
      </div>
    </main>
  );
}
