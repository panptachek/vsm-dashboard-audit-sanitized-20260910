import type { DashboardChampionshipResponse, DashboardPeriod } from '../types/dashboardChampionship';

function buildApiUrl(path: string): string {
  const viteEnv = import.meta.env as Record<string, string | undefined>;
  const base = viteEnv.VITE_API_BASE_URL ?? viteEnv.VITE_API_BASE ?? '';
  return `${base}${path}`;
}

export async function fetchDashboardChampionship(params: {
  period: DashboardPeriod;
  date?: string;
  signal?: AbortSignal;
}): Promise<DashboardChampionshipResponse> {
  const query = new URLSearchParams({ period: params.period });
  if (params.date) query.set('date', params.date);
  query.set('_ts', String(Date.now()));

  const response = await fetch(buildApiUrl(`/api/dashboard/championship?${query}`), {
    signal: params.signal,
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Dashboard championship API failed: ${response.status} ${text.slice(0, 180)}`);
  }

  return response.json() as Promise<DashboardChampionshipResponse>;
}
