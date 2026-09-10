/**
 * WIP Overview FINAL — финальный дашборд по handoff dashik6.
 *
 * Порядок блоков:
 *   1. Возка (MaterialFlowBlock — реальные данные /api/wip/material-flow)
 *   2. Схемы АД (TempRoadsBlock — /api/wip/temp-roads/status)
 *   3. Свайные (PilesBlock — /api/wip/piles)
 *   4. Работы на участке (WorksBySectionBlock — /api/wip/works-by-section)
 *
 * Блок «Производительность техники» перенесён на вкладку «Аналитика».
 */
import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { LayoutGrid, Table2, Printer } from 'lucide-react'
import { PeriodBar } from './PeriodBar'
import { usePeriod } from './usePeriod'
import { QuarryMaterialFlowBlock, TransferMaterialFlowBlock } from './blocks/MaterialFlowBlock'
import { TempRoadsBlock } from './blocks/TempRoadsBlock'
import { PilesBlock } from './blocks/PilesBlock'
import { WorksBySectionBlock } from './blocks/WorksBySectionBlock'
import { ProblemsBlock } from './blocks/ProblemsBlock'
import { DailySummaryBlock } from './blocks/DailySummaryBlock'
import { OverviewOldReportTable } from './blocks/OverviewOldReportTable'
import { EquipmentPulseBlock } from './blocks/EquipmentPulseBlock'
import { exportDashboardPdf } from '../utils/pdfExport'

type ViewMode = 'table' | 'cards'

export default function WipOverviewFinal() {
  const { from, to } = usePeriod()
  const [view, setView] = useState<ViewMode>(
    () => (localStorage.getItem('vsm_overview_view') as ViewMode) || 'cards',
  )
  const [exportingPdf, setExportingPdf] = useState(false)
  useEffect(() => { localStorage.setItem('vsm_overview_view', view) }, [view])

  useQuery({
    queryKey: ['wip', 'contractors'],
    queryFn: () => fetch('/api/wip/contractors').then(r => r.json()),
    staleTime: 5 * 60_000,
  })

  return (
    <div className="flex flex-col min-h-full bg-bg-primary">
      <PeriodBar />

      <div className="px-4 sm:px-6 py-3 flex items-center gap-3 border-b border-border bg-white">
        <h1 className="text-xl font-heading font-bold text-text-primary mr-auto">
          Обзор
        </h1>
        <div className="no-print flex items-center gap-1 bg-bg-surface rounded-lg p-1">
          <ViewChip icon={LayoutGrid} active={view === 'cards'} onClick={() => setView('cards')} label="Карточки" />
          <ViewChip icon={Table2}     active={view === 'table'} onClick={() => setView('table')} label="Таблица" />
        </div>
        <button
          type="button"
          disabled={exportingPdf}
          onClick={async () => {
            setExportingPdf(true)
            try {
              await exportDashboardPdf({
                selector: '#overview-pdf-content',
                title: 'Обзор',
                subtitle: `${from} — ${to}`,
                filename: `Обзор ${from}-${to}`,
              })
            } finally {
              setExportingPdf(false)
            }
          }}
          className="no-print flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-accent-red text-white hover:bg-accent-burg transition disabled:cursor-wait disabled:opacity-60"
          title="Скачать PDF отчёт"
        >
          <Printer className="w-3.5 h-3.5" /> {exportingPdf ? 'PDF...' : 'PDF'}
        </button>
      </div>

      {/* Порядок по handoff: Возка → Схемы АД → Свайные → Производительность техники */}
      <div id="overview-pdf-content" className="p-4 sm:p-6 pb-24 lg:pb-6 space-y-6">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <EquipmentPulseBlock from={from} to={to} />
        </motion.div>
        {view === 'cards' && (
          <>
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.02 }}>
              <ProblemsBlock to={to} />
            </motion.div>
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.04 }}>
              <DailySummaryBlock from={from} to={to} variant="dashboard" />
            </motion.div>
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.06 }}>
              <QuarryMaterialFlowBlock from={from} to={to} view={view} />
            </motion.div>
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.07 }}>
              <TransferMaterialFlowBlock from={from} to={to} view={view} />
            </motion.div>
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }}>
              <TempRoadsBlock to={to} view={view} />
            </motion.div>
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.10 }}>
              <PilesBlock from={from} to={to} view={view} />
            </motion.div>
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
              <WorksBySectionBlock from={from} to={to} />
            </motion.div>
          </>
        )}
        {view === 'table' && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            <OverviewOldReportTable to={to} />
          </motion.div>
        )}
      </div>
    </div>
  )
}

function ViewChip({
  icon: Icon, active, onClick, label,
}: {
  icon: React.ElementType; active: boolean; onClick: () => void; label: string
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-xs font-medium rounded-md flex items-center gap-1.5 transition ${
        active ? 'bg-white shadow-sm text-text-primary' : 'text-text-muted hover:text-text-primary'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  )
}
