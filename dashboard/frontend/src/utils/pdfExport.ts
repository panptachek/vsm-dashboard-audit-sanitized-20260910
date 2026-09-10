import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'

interface ExportOptions {
  selector: string
  title?: string
  filename: string
  subtitle?: string
}


function pdfColorVariableOverrides(): string {
  return `
    :root, :host {
      --color-red-50:#fef2f2; --color-red-100:#fee2e2; --color-red-200:#fecaca; --color-red-300:#fca5a5; --color-red-400:#f87171; --color-red-500:#ef4444; --color-red-600:#dc2626; --color-red-700:#b91c1c; --color-red-800:#991b1b; --color-red-900:#7f1d1d; --color-red-950:#450a0a;
      --color-orange-50:#fff7ed; --color-orange-100:#ffedd5; --color-orange-800:#9a3412;
      --color-amber-50:#fffbeb; --color-amber-100:#fef3c7; --color-amber-200:#fde68a; --color-amber-300:#fcd34d; --color-amber-400:#fbbf24; --color-amber-500:#f59e0b; --color-amber-700:#b45309; --color-amber-800:#92400e; --color-amber-900:#78350f;
      --color-green-50:#f0fdf4; --color-green-200:#bbf7d0; --color-green-700:#15803d; --color-green-800:#166534;
      --color-emerald-50:#ecfdf5; --color-emerald-100:#d1fae5; --color-emerald-200:#a7f3d0; --color-emerald-300:#6ee7b7; --color-emerald-400:#34d399; --color-emerald-600:#059669; --color-emerald-700:#047857; --color-emerald-800:#065f46; --color-emerald-900:#064e3b;
      --color-cyan-50:#ecfeff; --color-cyan-100:#cffafe; --color-cyan-950:#083344;
      --color-sky-50:#f0f9ff; --color-sky-100:#e0f2fe; --color-sky-200:#bae6fd; --color-sky-300:#7dd3fc; --color-sky-500:#0ea5e9; --color-sky-600:#0284c7; --color-sky-700:#0369a1; --color-sky-800:#075985; --color-sky-900:#0c4a6e;
      --color-blue-50:#eff6ff; --color-blue-200:#bfdbfe; --color-blue-700:#1d4ed8;
      --color-purple-50:#faf5ff; --color-purple-100:#f3e8ff; --color-purple-700:#7e22ce; --color-purple-900:#581c87;
      --color-pink-100:#fce7f3; --color-pink-700:#be185d; --color-pink-900:#831843;
      --color-rose-100:#ffe4e6; --color-rose-300:#fda4af; --color-rose-900:#881337;
      --color-slate-300:#cbd5e1; --color-slate-700:#334155; --color-slate-800:#1e293b; --color-slate-900:#0f172a; --color-slate-950:#020617;
      --color-gray-200:#e5e7eb; --color-gray-500:#6b7280; --color-gray-600:#4b5563; --color-gray-700:#374151; --color-gray-800:#1f2937;
      --color-neutral-50:#fafafa; --color-neutral-100:#f5f5f5; --color-neutral-200:#e5e5e5; --color-neutral-300:#d4d4d4; --color-neutral-400:#a3a3a3; --color-neutral-500:#737373; --color-neutral-600:#525252; --color-neutral-700:#404040; --color-neutral-800:#262626; --color-neutral-900:#171717; --color-neutral-950:#0a0a0a;
      --tw-ring-color: rgba(220, 38, 38, 0.25);
    }
    *::placeholder { color: #9ca3af !important; }
  `
}


type CssRuleContainer = {
  cssRules: CSSRuleList
  deleteRule: (index: number) => void
}

const UNSUPPORTED_COLOR_RE = /oklch|oklab|color-mix/i

function fallbackCssValue(property: string): string | null {
  if (property.startsWith('--color-')) return '#1f2937'
  if (property.includes('shadow')) return 'none'
  if (property.includes('border') && property.includes('color')) return '#e5e7eb'
  if (property.includes('background') && property.includes('color')) return '#ffffff'
  if (property.includes('text-decoration')) return '#737373'
  if (property.includes('outline') && property.includes('color')) return '#dc2626'
  if (property.includes('ring')) return 'rgba(220, 38, 38, 0.25)'
  if (property.includes('color') || property === 'fill' || property === 'stroke') return '#1f2937'
  return null
}

function sanitizeStyleDeclaration(style: CSSStyleDeclaration) {
  for (let index = style.length - 1; index >= 0; index -= 1) {
    const property = style.item(index)
    const value = style.getPropertyValue(property)
    if (!UNSUPPORTED_COLOR_RE.test(value)) continue
    const fallback = fallbackCssValue(property)
    if (fallback) style.setProperty(property, fallback, style.getPropertyPriority(property))
    else style.removeProperty(property)
  }
}

function stripUnsupportedColorRules(container: CssRuleContainer) {
  for (let index = container.cssRules.length - 1; index >= 0; index -= 1) {
    const rule = container.cssRules[index] as CSSRule & Partial<CssRuleContainer> & { style?: CSSStyleDeclaration }
    if (rule.style) sanitizeStyleDeclaration(rule.style)
    if (rule.cssRules) stripUnsupportedColorRules(rule as CSSRule & CssRuleContainer)
    if (UNSUPPORTED_COLOR_RE.test(rule.cssText)) {
      try {
        if (!rule.cssRules || rule.cssRules.length === 0) container.deleteRule(index)
      } catch {
        // Some browser-generated rules are read-only; computed-style sanitizing still covers them.
      }
    }
  }
}

function fallbackComputedColor(element: Element, property: string): string {
  const className = typeof element.getAttribute === 'function' ? element.getAttribute('class') || '' : ''
  if (property.includes('border')) return '#e5e7eb'
  if (property.includes('background')) {
    if (className.includes('bg-bg-primary')) return '#f5f5f5'
    if (className.includes('bg-bg-surface')) return '#fafafa'
    if (className.includes('bg-accent-red')) return '#dc2626'
    if (className.includes('bg-accent-burg')) return '#7f1d1d'
    if (className.includes('bg-amber')) return '#fffbeb'
    if (className.includes('bg-red')) return '#fef2f2'
    if (className.includes('bg-green') || className.includes('bg-emerald')) return '#ecfdf5'
    return '#ffffff'
  }
  if (className.includes('text-white')) return '#ffffff'
  if (className.includes('text-text-muted')) return '#737373'
  if (className.includes('text-text-secondary')) return '#404040'
  if (className.includes('text-accent-red')) return '#dc2626'
  if (className.includes('text-progress-green')) return '#16a34a'
  if (className.includes('text-progress-amber')) return '#d97706'
  return '#171717'
}

function sanitizeComputedColors(clonedDocument: Document) {
  const view = clonedDocument.defaultView
  if (!view || !clonedDocument.body) return
  const properties = [
    'color', 'background-color', 'border-top-color', 'border-right-color',
    'border-bottom-color', 'border-left-color', 'outline-color',
    'text-decoration-color', 'fill', 'stroke', 'box-shadow', 'text-shadow',
  ]
  const elements = [clonedDocument.body, ...Array.from(clonedDocument.body.querySelectorAll('*'))]
  for (const element of elements) {
    const computed = view.getComputedStyle(element)
    const inlineStyle = (element as HTMLElement | SVGElement).style
    if (!inlineStyle) continue
    for (const property of properties) {
      const value = computed.getPropertyValue(property)
      if (!UNSUPPORTED_COLOR_RE.test(value)) continue
      if (property.includes('shadow')) inlineStyle.setProperty(property, 'none', 'important')
      else inlineStyle.setProperty(property, fallbackComputedColor(element, property), 'important')
    }
  }
}

function prepareCloneForPdf(clonedDocument: Document) {
  for (const sheet of Array.from(clonedDocument.styleSheets)) {
    try {
      stripUnsupportedColorRules(sheet as CSSStyleSheet & CssRuleContainer)
    } catch {
      // Ignore inaccessible sheets; dashboard assets are same-origin, so this is only a guard.
    }
  }
  const style = clonedDocument.createElement('style')
  style.textContent = pdfColorVariableOverrides()
  clonedDocument.head.appendChild(style)
  sanitizeComputedColors(clonedDocument)
}

function sanitizeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'report'
}

async function renderElement(element: HTMLElement): Promise<HTMLCanvasElement> {
  if ('fonts' in document) {
    await document.fonts.ready.catch(() => undefined)
  }
  return html2canvas(element, {
    backgroundColor: '#ffffff',
    scale: Math.min(2, window.devicePixelRatio || 1.5),
    useCORS: true,
    logging: false,
    onclone: clonedDocument => {
      prepareCloneForPdf(clonedDocument)
    },
    ignoreElements: node => node instanceof HTMLElement && node.classList.contains('no-print'),
  })
}

export async function exportDashboardPdf({ selector, title, filename, subtitle }: ExportOptions): Promise<void> {
  const root = document.querySelector<HTMLElement>(selector)
  if (!root) throw new Error('Не найден блок для PDF')

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true })
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const margin = 10
  const contentWidth = pageWidth - margin * 2
  let y = margin

  pdf.setFillColor(255, 255, 255)
  pdf.rect(0, 0, pageWidth, pageHeight, 'F')
  if (title) {
    pdf.setTextColor(26, 26, 26)
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(16)
    pdf.text(title, margin, y + 2)
    y += 8
  }
  if (subtitle) {
    pdf.setFont('helvetica', 'normal')
    pdf.setFontSize(9)
    pdf.setTextColor(90, 90, 90)
    pdf.text(subtitle, margin, y)
    y += 7
  }

  const blocks = Array.from(root.children).filter((node): node is HTMLElement => (
    node instanceof HTMLElement && !node.classList.contains('no-print') && node.offsetHeight > 0 && node.offsetWidth > 0
  ))
  const targets = blocks.length ? blocks : [root]

  for (const block of targets) {
    const canvas = await renderElement(block)
    const imgWidth = contentWidth
    let imgHeight = canvas.height * imgWidth / Math.max(1, canvas.width)
    let drawWidth = imgWidth
    if (imgHeight > pageHeight - margin * 2) {
      imgHeight = pageHeight - margin * 2
      drawWidth = canvas.width * imgHeight / Math.max(1, canvas.height)
    }
    if (y + imgHeight > pageHeight - margin) {
      pdf.addPage('a4', 'portrait')
      y = margin
    }
    const x = margin + (contentWidth - drawWidth) / 2
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', x, y, drawWidth, imgHeight, undefined, 'FAST')
    y += imgHeight + 6
  }

  pdf.save(`${sanitizeFilename(filename)}.pdf`)
}
