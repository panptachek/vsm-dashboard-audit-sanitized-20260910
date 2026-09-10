export type DashboardPeriod = 'day' | 'week';

export type DashboardLeaderboardKey =
  | 'overall'
  | 'sandTransport'
  | 'sandPlacement'
  | 'pilesAbsolute'
  | 'pilesPlan'
  | 'pilesPerRig'
  | 'equipment'
  | 'otherWorks';

export type DataQuality = 'ok' | 'partial' | 'stale' | 'missing';

export type DashboardScoreWeights = {
  sandTransport: number;
  sandPlacement: number;
  pilesAbsolute: number;
  pilesPlan: number;
  pilesPerRig: number;
  equipment: number;
  otherWorks: number;
  dataQuality: number;
};

export type SectionChampionshipMetrics = {
  sectionId: string;
  sectionCode: string;
  sectionName: string;
  sectionNumber?: number;
  color?: string;
  photoUrl?: string;
  lastDataAt?: string;
  rank: number;

  sand: {
    transportedM3: number;
    transportTrips?: number;
    transportPlanM3?: number | null;
    transportPct?: number | null;
    placedM3: number;
    placementPlanM3?: number | null;
    placementPct?: number | null;
  };

  piles: {
    drivenCount: number;
    planCount?: number | null;
    percentPlan?: number | null;
    rigsCount: number;
    drivenPerRig: number;
  };

  equipment: {
    totalUnits: number;
    activeUnits: number;
    idleUnits: number;
    idleHours: number;
    availableHours?: number | null;
    idleRate?: number | null;
    availabilityScore: number;
  };

  otherWorks: {
    totalM3: number;
    excavationM3: number;
    peatRemovalM3: number;
    prsM3: number;
    pgsM3: number;
    shpgsM3: number;
    crushedStoneM3: number;
    geotextileM2: number;
    byTag: Array<{ tag: string; unit: string; volume: number }>;
  };

  scores: {
    sandTransport: number;
    sandPlacement: number;
    pilesAbsolute: number;
    pilesPlan: number;
    pilesPerRig: number;
    equipment: number;
    otherWorks: number;
    overall: number;
    dataQualityPenalty: number;
  };

  strengths: string[];
  risks: string[];
  badges: string[];
  dataQuality: DataQuality;
};

export type DashboardChampionshipResponse = {
  period: DashboardPeriod;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  updatedAt?: string;
  sourceDateNote?: string | null;
  weights: DashboardScoreWeights;
  leaders: Record<DashboardLeaderboardKey, string | null>;
  rankings: Record<DashboardLeaderboardKey, string[]>;
  sections: SectionChampionshipMetrics[];
  notes: string[];
};
