import { AppWindow, BadgeCheck, Building2, ChartGantt, CloudCog, Compass, FileCheck2, FileText, FolderKanban, KeyRound, LayoutDashboard, Settings, UsersRound } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useApp } from '../../state/store';
import type { Area } from '../../state/roles';
import { useSessionOptional } from '../../api/session';
import { scopeText } from '../../lib/scope';

const PRIMARY: { to: string; label: string; icon: typeof LayoutDashboard; area: Area }[] = [
  { to: '/my-licences', label: 'My Licences', icon: BadgeCheck, area: 'mylicences' },
  { to: '/overview', label: 'Overview', icon: LayoutDashboard, area: 'overview' },
  { to: '/team', label: 'Team & Access', icon: UsersRound, area: 'team' },
  { to: '/registry', label: 'Licence & Project', icon: FolderKanban, area: 'registry' },
  { to: '/planning', label: 'Planning Studio', icon: Compass, area: 'planning' },
  { to: '/review', label: 'Review', icon: FileCheck2, area: 'review' },
];

const OPS: { to: string; label: string; icon: typeof LayoutDashboard; area: Area }[] = [
  { to: '/software', label: 'Software', icon: AppWindow, area: 'software' },
  { to: '/projects', label: 'Projects', icon: ChartGantt, area: 'projects' },
  { to: '/access-requests', label: 'Access Requests', icon: KeyRound, area: 'requests' },
  { to: '/other-services', label: 'Other Services', icon: CloudCog, area: 'services' },
  { to: '/vendors', label: 'Vendors', icon: Building2, area: 'vendors' },
  { to: '/reports', label: 'Reports', icon: FileText, area: 'reports' },
  { to: '/settings', label: 'Settings', icon: Settings, area: 'settings' },
];

export function Sidebar() {
  const { perms, state, ds, me } = useApp();
  const session = useSessionOptional();
  const inScope = (requesterId: string) => !perms.deptScope || ds.users.find((u) => u.id === requesterId)?.deptId === perms.deptScope;
  const pendingRequests = state.requests.filter((r) => (perms.approveRequests && r.status === 'submitted' && inScope(r.requesterId)) || (perms.fulfilRequests && r.status === 'approved')).length;
  const mineOpen = perms.submitRequests ? state.requests.filter((r) => r.requesterId === me.id && r.status === 'more-info').length : 0;
  const pendingApprovals = state.recommendations.filter((r) => r.status === 'pending').length;
  const show = (a: Area) => perms.areas.includes(a);
  return (
    <aside className="sidebar" aria-label="Main navigation">
      <div className="brand">
        <div className="brand-name">
          Kirloskar <span>Pneumatic</span>
        </div>
        <div className="brand-sub">Licence Intelligence</div>
      </div>
      <nav className="nav">
        <div className="nav-group">
          {PRIMARY.filter((i) => show(i.area)).map((i) => (
            <NavLink key={i.to} to={i.to} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} title={i.label}>
              <i.icon aria-hidden />
              <span>{i.label}</span>
              {i.to === '/registry' && pendingApprovals > 0 && (perms.approvalSteps.length > 0) && <em className="nav-count">{pendingApprovals}</em>}
            </NavLink>
          ))}
        </div>
        <div className="nav-group">
          <div className="nav-caption">Operations</div>
          {OPS.filter((i) => show(i.area)).map((i) => (
            <NavLink key={i.to} to={i.to} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} title={i.label}>
              <i.icon aria-hidden />
              <span>{i.label}</span>
              {i.to === '/access-requests' && pendingRequests + mineOpen > 0 && <em className="nav-count">{pendingRequests + mineOpen}</em>}
            </NavLink>
          ))}
        </div>
      </nav>
      <div className="sidebar-foot">
        {session && (
          <div style={{ marginBottom: 6 }}>
            <strong>{session.profile_label}</strong> · {scopeText(session.scope.level, session.department, session.scope.projects)}
          </div>
        )}
        <strong>Prototype</strong> · sample data. Your profile and scope come from your employee record; the API enforces them on every call.
      </div>
    </aside>
  );
}
