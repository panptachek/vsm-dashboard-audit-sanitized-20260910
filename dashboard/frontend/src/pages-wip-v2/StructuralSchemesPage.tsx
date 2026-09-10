import { FileStack } from 'lucide-react'
import { PeriodBar } from './PeriodBar'
import { usePeriod } from './usePeriod'
import { TempRoadsBlock } from './blocks/TempRoadsBlock'

export default function StructuralSchemesPage() {
  const { to } = usePeriod()

  return (
    <div className="flex min-h-full flex-col bg-bg-primary">
      <PeriodBar />
      <div className="border-b border-border bg-white px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <FileStack className="h-5 w-5 text-text-primary" strokeWidth={2} />
          <div className="min-w-0">
            <h1 className="font-heading text-xl font-bold text-text-primary">Структурные схемы</h1>
            <div className="text-xs text-text-muted">ВАД и ОХ по выбранной дате с объектами, РД и сроками</div>
          </div>
        </div>
      </div>
      <div className="p-4 pb-24 sm:p-6 lg:pb-6">
        <TempRoadsBlock to={to} view="cards" initialMode="mainline" />
      </div>
    </div>
  )
}
