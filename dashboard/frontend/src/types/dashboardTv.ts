export type DashboardPeriod = 'day' | 'week';

export type DashboardTvQuarry = {
  name: string;
  volumeM3: number;
  jdsM3: number;
  trips: number;
};

export type DashboardTvSandTag = {
  tag: string;
  unit: string;
  volume: number;
};

export type EquipmentAlertSeverity = 'low' | 'high';

export type EquipmentAlert = {
  sectionCode: string;
  sectionName: string;
  color?: string;
  label: string;
  percent: number;
  severity: EquipmentAlertSeverity;
  fact?: number | null;
  expected?: number | null;
};

export type EquipmentCategory = {
  equipmentType: string;
  label: string;
  percent: number | null;
  factM3: number;
  factM2: number;
  avgUnits: number;
  workShifts: number;
};

export type DashboardTvSection = {
  sectionCode: string;
  sectionName: string;
  sectionNumber?: number | null;
  color?: string;
  sandQuarry: {
    totalM3: number;
    jdsM3: number;
    otherM3: number;
    trips: number;
    jdsTrips: number;
    quarries: DashboardTvQuarry[];
  };
  sandPlaced: {
    totalM3: number;
    byTag: DashboardTvSandTag[];
  };
  equipment: {
    utilizationPct: number | null;
    categories: EquipmentCategory[];
    alerts: EquipmentAlert[];
    activeUnits: number;
    totalUnits: number;
  };
  piles: {
    main: number;
    trial: number;
    total: number;
    planMain: number;
    planTrial: number;
    previousDayMain: number;
    previousDayTrial: number;
    previousDayTotal: number;
    currentDayMain: number;
    currentDayTrial: number;
    currentDayTotal: number;
    trendDelta: number;
  };
};

export type PileDynamicsSection = {
  sectionCode: string;
  sectionName: string;
  color?: string;
  previous: number;
  current: number;
  delta: number;
  currentMain: number;
  currentTrial: number;
};

export type DashboardTvResponse = {
  period: DashboardPeriod;
  periodStart: string;
  periodEnd: string;
  previousDate: string;
  currentDate: string;
  generatedAt: string;
  updatedAt?: string | null;
  sourceDateNote?: string | null;
  cycleSeconds: number;
  sections: DashboardTvSection[];
  totals: {
    sandQuarryM3: number;
    sandQuarryJdsM3: number;
    sandPlacedM3: number;
    pileMain: number;
    pileTrial: number;
    pileTotal: number;
    maxSandQuarryM3: number;
    maxSandPlacedM3: number;
    maxPileTotal: number;
    equipmentMeanPct: number;
  };
  equipmentAlerts: EquipmentAlert[];
  pileDynamics: {
    previousDate: string;
    currentDate: string;
    sections: PileDynamicsSection[];
  };
  notes: string[];
};
