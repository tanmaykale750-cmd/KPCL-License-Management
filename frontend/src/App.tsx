import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import { AppLayout, Guard } from './components/shell/AppLayout';
import { OverviewPage } from './pages/overview/OverviewPage';
import { useApp } from './state/store';

const RegistryPage = lazy(() => import('./pages/registry/RegistryPage'));
const PlanningPage = lazy(() => import('./pages/planning/PlanningPage'));
const ReviewPage = lazy(() => import('./pages/review/ReviewPage'));
const SoftwarePage = lazy(() => import('./pages/ops/SoftwarePage'));
const ProjectsPage = lazy(() => import('./pages/ops/ProjectsPage'));
const RequestsPage = lazy(() => import('./pages/ops/RequestsPage'));
const OtherServicesPage = lazy(() => import('./pages/services/OtherServicesPage'));
const VendorsPage = lazy(() => import('./pages/ops/VendorsPage'));
const ReportsPage = lazy(() => import('./pages/ops/ReportsPage'));
const SettingsPage = lazy(() => import('./pages/ops/SettingsPage'));
const TeamPage = lazy(() => import('./pages/team/TeamPage'));
const MyLicencesPage = lazy(() => import('./pages/me/MyLicencesPage'));

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="empty">Loading…</div>}>{children}</Suspense>;
}

function Landing() {
  const { perms } = useApp();
  return <Navigate to={perms.landing} replace />;
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Landing /> },
      { path: 'overview', element: <Guard area="overview"><OverviewPage /></Guard> },
      { path: 'registry', element: <Guard area="registry"><Lazy><RegistryPage /></Lazy></Guard> },
      { path: 'planning', element: <Guard area="planning"><Lazy><PlanningPage /></Lazy></Guard> },
      { path: 'review', element: <Guard area="review"><Lazy><ReviewPage /></Lazy></Guard> },
      { path: 'software', element: <Guard area="software"><Lazy><SoftwarePage /></Lazy></Guard> },
      { path: 'projects', element: <Guard area="projects"><Lazy><ProjectsPage /></Lazy></Guard> },
      { path: 'access-requests', element: <Guard area="requests"><Lazy><RequestsPage /></Lazy></Guard> },
      { path: 'other-services', element: <Guard area="services"><Lazy><OtherServicesPage /></Lazy></Guard> },
      { path: 'vendors', element: <Guard area="vendors"><Lazy><VendorsPage /></Lazy></Guard> },
      { path: 'reports', element: <Guard area="reports"><Lazy><ReportsPage /></Lazy></Guard> },
      { path: 'settings', element: <Guard area="settings"><Lazy><SettingsPage /></Lazy></Guard> },
      { path: 'team', element: <Guard area="team"><Lazy><TeamPage /></Lazy></Guard> },
      { path: 'my-licences', element: <Guard area="mylicences"><Lazy><MyLicencesPage /></Lazy></Guard> },
      { path: '*', element: <Landing /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
