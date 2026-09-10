/**
 * Блок «Проблемные вопросы» — в самом начале Обзора.
 * Красный акцент, дата + участок + текст. Пустой state — дружелюбное сообщение.
 */
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'

interface Problem {
  section_code: string
  date: string
  text: string
}

export function ProblemsBlock({ to }: { to: string }) {
  const { data, isLoading } = useQuery<{ problems: Problem[] }>({
    queryKey: ['wip', 'daily-summary', 'problems', to],
    queryFn: () => fetch(`/api/wip/analytics/daily-summary?to=${to}`).then(r => r.json()),
  })

  if (isLoading || !data) return null
  const problems = data.problems ?? []
  if (problems.length === 0) {
    return (
      <section className="bg-white border border-border rounded-xl p-4 shadow-sm">
        <div className="flex items-center gap-2 text-[13px] text-text-muted">
          <AlertTriangle className="w-4 h-4 text-text-muted" strokeWidth={2} />
          <span>Проблемных вопросов на выбранную дату не указано.</span>
        </div>
      </section>
    )
  }
  return (
    <section className="bg-white border-l-4 border-l-accent-red border border-border rounded-xl p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="w-5 h-5 text-accent-red" strokeWidth={2.2} />
        <h2 className="text-base font-semibold text-accent-red mb-2 font-heading tracking-wide uppercase">
          Проблемные вопросы ({problems.length})
        </h2>
      </div>
      <ul className="space-y-2 text-[13px]">
        {problems.map((p, i) => (
          <li key={i} className="flex items-start gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-accent-red mt-2 shrink-0" />
            <div>
              <div className="text-[11px] font-mono text-text-muted">
                {new Date(p.date).toLocaleDateString('ru-RU')} · {p.section_code.replace('UCH_', 'Участок №')}
              </div>
              <div className="text-text-primary">{p.text}</div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
