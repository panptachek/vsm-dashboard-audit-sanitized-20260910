import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Layout } from './components/Layout'
import { GlobalAnnouncement } from './components/GlobalAnnouncement'
import { RouteErrorBoundary } from './components/RouteErrorBoundary'
import { lazy, Suspense } from 'react'
import type { ReactNode } from 'react'
import { AuthProvider, LoginScreen, useAuth } from './auth'
import type { AuthUser } from './auth'
import { canAccessPath, defaultRouteForUser } from './access'

const DashboardPage = lazy(() => import('./pages-wip-v2/DashboardPage'))
const AnalyticsFinal = lazy(() => import('./pages-wip-v2/AnalyticsFinal'))
const SectionRatingPage = lazy(() => import('./pages-wip-v2/SectionRatingPage'))
const MapV3 = lazy(() => import('./pages-wip-v2/MapV3'))
const MechanizationPage = lazy(() => import('./pages-wip-v2/MechanizationPage'))
const PersonnelAccommodationPage = lazy(() => import('./pages-wip-v2/PersonnelAccommodationPage'))
const ReinforcementSectionsPage = lazy(() => import('./pages-wip-v2/ReinforcementSectionsBoard'))
const EarthworksPage = lazy(() => import('./pages-wip-v2/EarthworksPage'))
const StructuralSchemesPage = lazy(() => import('./pages-wip-v2/StructuralSchemesPage'))
const PileControlPage = lazy(() => import('./pages-wip-v2/PileControlPage'))
const ReportsPage = lazy(() => import('./pages-wip-v2/ReportsPage'))
const StatementsPage = lazy(() => import('./pages-wip-v2/StatementsPage'))
const GeneratorPage = lazy(() => import('./pages-wip-v2/GeneratorPage'))
const DatabasePage = lazy(() => import('./pages-wip-v2/DatabasePage'))
const SettingsPage = lazy(() => import('./pages-wip-v2/SettingsPage'))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2 * 60_000,
      gcTime: 10 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

function Fallback() {
  return <div style={{ padding: 40, textAlign: 'center', color: '#6b6b6b' }}>Загрузка...</div>
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AuthenticatedApp />
      </AuthProvider>
    </QueryClientProvider>
  )
}

function GuardedRoute({ path, children }: { path: string; children: ReactNode }) {
  const { user } = useAuth()
  if (!canAccessPath(user, path)) {
    return <Navigate to={defaultRouteForUser(user)} replace />
  }
  return <>{children}</>
}

function AuthenticatedApp() {
  const { user, isLoading } = useAuth()
  if (isLoading) return <Fallback />
  if (!user) return <LoginScreen />
  return (
    <BrowserRouter>
      <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-bg-primary">
        <GlobalAnnouncement />
        <div className="min-h-0 flex-1 overflow-auto">
          <AppRoutes user={user} />
        </div>
      </div>
    </BrowserRouter>
  )
}

function AppRoutes({ user }: { user: AuthUser }) {
  const loc = useLocation()
  return (
    <RouteErrorBoundary resetKey={loc.pathname}>
      <Routes>
        <Route path="/pile" element={<GuardedRoute path="/pile"><Suspense fallback={<Fallback />}><PileControlPage standalone /></Suspense></GuardedRoute>} />
        <Route path="/pilereports" element={<GuardedRoute path="/pilereports"><Suspense fallback={<Fallback />}><ReportsPage standaloneMode="pile-control" /></Suspense></GuardedRoute>} />
        <Route element={<Layout />}>
          <Route path="/" element={<GuardedRoute path="/"><Suspense fallback={<Fallback />}><DashboardPage /></Suspense></GuardedRoute>} />
          <Route path="/dashboard" element={<GuardedRoute path="/dashboard"><Navigate to="/" replace /></GuardedRoute>} />
          <Route path="/map" element={<GuardedRoute path="/map"><Suspense fallback={<Fallback />}><MapV3 /></Suspense></GuardedRoute>} />
          <Route path="/analytics" element={<GuardedRoute path="/analytics"><Suspense fallback={<Fallback />}><AnalyticsFinal /></Suspense></GuardedRoute>} />
          <Route path="/section-rating" element={<GuardedRoute path="/section-rating"><Suspense fallback={<Fallback />}><SectionRatingPage /></Suspense></GuardedRoute>} />
          <Route path="/mechanization" element={<GuardedRoute path="/mechanization"><Suspense fallback={<Fallback />}><MechanizationPage /></Suspense></GuardedRoute>} />
          <Route path="/personnel-accommodation" element={<GuardedRoute path="/personnel-accommodation"><Suspense fallback={<Fallback />}><PersonnelAccommodationPage /></Suspense></GuardedRoute>} />
          <Route path="/reinforcement" element={<GuardedRoute path="/reinforcement"><Suspense fallback={<Fallback />}><ReinforcementSectionsPage /></Suspense></GuardedRoute>} />
          <Route path="/zem-polotno" element={<GuardedRoute path="/zem-polotno"><Suspense fallback={<Fallback />}><EarthworksPage /></Suspense></GuardedRoute>} />
          <Route path="/structural-schemes" element={<GuardedRoute path="/structural-schemes"><Suspense fallback={<Fallback />}><StructuralSchemesPage /></Suspense></GuardedRoute>} />
          <Route path="/pile-control" element={<GuardedRoute path="/pile"><Navigate to="/pile" replace /></GuardedRoute>} />
          <Route path="/reports" element={<GuardedRoute path="/reports"><Suspense fallback={<Fallback />}><ReportsPage /></Suspense></GuardedRoute>} />
          <Route path="/statements" element={<GuardedRoute path="/statements"><Suspense fallback={<Fallback />}><StatementsPage /></Suspense></GuardedRoute>} />
          <Route path="/generator" element={<GuardedRoute path="/generator"><Suspense fallback={<Fallback />}><GeneratorPage /></Suspense></GuardedRoute>} />
          <Route path="/database" element={<GuardedRoute path="/database"><Suspense fallback={<Fallback />}><DatabasePage /></Suspense></GuardedRoute>} />
          <Route path="/settings" element={<GuardedRoute path="/settings"><Suspense fallback={<Fallback />}><SettingsPage /></Suspense></GuardedRoute>} />
          <Route path="*" element={<Navigate to={defaultRouteForUser(user)} replace />} />
        </Route>
      </Routes>
    </RouteErrorBoundary>
  )
}
