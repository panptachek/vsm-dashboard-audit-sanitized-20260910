export type TempRoadFillStatusKey =
  | 'pioneer_fill'
  | 'subgrade_not_to_grade'
  | 'dso'
  | 'ready_for_shpgs'
  | 'shpgs_done'
  | 'no_work'

export type MainlineFillStatusKey =
  | 'prep_works'
  | 'main_works'
  | 'protective_layer_2'
  | 'protective_layer_1'
  | 'asphalt_layer'
  | 'no_work'

export interface FillStatusDefinition<T extends string = string> {
  key: T
  label: string
  shortLabel: string
  description: string
  fill: string
  stroke: string
}

export const TEMP_ROAD_FILL_STATUS_DEFINITIONS: FillStatusDefinition<TempRoadFillStatusKey>[] = [
  {
    key: 'pioneer_fill',
    label: 'пионерка',
    shortLabel: 'Пионерка',
    description: 'Пионерный проезд, работы производятся не на проектную ширину; работы - снятие ПРС, выторфовка, замена грунта',
    fill: '#E8DDF5',
    stroke: '#7c3aed',
  },
  {
    key: 'subgrade_not_to_grade',
    label: 'не в отметку',
    shortLabel: 'ЗП в работе',
    description: 'Производство работ по устройству земляного полотна на проектную ширину; работы - насыпь, выемка, выторфовка, замена грунта',
    fill: '#FCE5CD',
    stroke: '#d97706',
  },
  {
    key: 'dso',
    label: 'устройство ДСО',
    shortLabel: 'ДСО',
    description: 'Работы по устройству земляного полотна завершены, устройство дополнительного слоя основания дорожной одежды из песка',
    fill: '#FFF2CC',
    stroke: '#ca8a04',
  },
  {
    key: 'ready_for_shpgs',
    label: 'готово под ЩПГС',
    shortLabel: 'Под ЩПГС',
    description: 'Работы по отсыпке и профилированию ДСО завершены, геотекстиль уложен, конструктив готов к приемке ЩПГС дорожной одежды',
    fill: '#D9EAF7',
    stroke: '#2563eb',
  },
  {
    key: 'shpgs_done',
    label: 'ЩПГС уложен',
    shortLabel: 'ЩПГС уложен',
    description: 'Работы по устройству ЗП и ДО завершены, конструктив готов к приему асфальтобетона',
    fill: '#D9EAD3',
    stroke: '#16a34a',
  },
  {
    key: 'no_work',
    label: 'не в работе',
    shortLabel: 'Не в работе',
    description: 'На участке нет активного статуса отсыпки на выбранную дату',
    fill: '#f8fafc',
    stroke: '#6b7280',
  },
]

export const MAINLINE_FILL_STATUS_DEFINITIONS: FillStatusDefinition<MainlineFillStatusKey>[] = [
  {
    key: 'prep_works',
    label: 'Подготовительные работы',
    shortLabel: 'Подготовка',
    description: 'Срезка ПРС, выторфовка, замена грунта',
    fill: '#E8DDF5',
    stroke: '#7c3aed',
  },
  {
    key: 'main_works',
    label: 'Основные работы',
    shortLabel: 'Основные',
    description: 'Работы по выторфовке, замене грунта, устройство выемки/насыпи',
    fill: '#FCE5CD',
    stroke: '#d97706',
  },
  {
    key: 'protective_layer_2',
    label: 'Устройство защитного слоя №2',
    shortLabel: 'ЗС №2',
    description: 'Производство работ по устройству второго морозоустойчивого защитного слоя из песка гравелистого/крупного/ПГС',
    fill: '#FFF2CC',
    stroke: '#ca8a04',
  },
  {
    key: 'protective_layer_1',
    label: 'Устройство защитного слоя №1',
    shortLabel: 'ЗС №1',
    description: 'Производство работ по устройству первого защитного слоя из ЩПС/ЩПГС',
    fill: '#D9EAF7',
    stroke: '#2563eb',
  },
  {
    key: 'asphalt_layer',
    label: 'Устройство асфальтобетонного покрытия',
    shortLabel: 'Асфальтобетон',
    description: 'Производство работ по укладке защитного слоя из асфальтобетона',
    fill: '#D9EAD3',
    stroke: '#16a34a',
  },
  {
    key: 'no_work',
    label: 'не в работе',
    shortLabel: 'Не в работе',
    description: 'На участке нет активного статуса отсыпки на выбранную дату',
    fill: '#f8fafc',
    stroke: '#6b7280',
  },
]

export const TEMP_ROAD_FILL_STATUS_BY_KEY = Object.fromEntries(
  TEMP_ROAD_FILL_STATUS_DEFINITIONS.map(item => [item.key, item]),
) as Record<TempRoadFillStatusKey, FillStatusDefinition<TempRoadFillStatusKey>>

export const MAINLINE_FILL_STATUS_BY_KEY = Object.fromEntries(
  MAINLINE_FILL_STATUS_DEFINITIONS.map(item => [item.key, item]),
) as Record<MainlineFillStatusKey, FillStatusDefinition<MainlineFillStatusKey>>
