import { NavLink } from 'react-router-dom';
import { Ico } from '../icons';

const TABS = [
  { to: '/', label: 'Home', icon: 'home', end: true },
  { to: '/activity', label: 'Activity', icon: 'activity', end: false },
  { to: '/budgets', label: 'Budgets', icon: 'budgets', end: false },
  { to: '/wealth', label: 'Wealth', icon: 'wealth', end: false },
];

export function TabBar() {
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => 'tab' + (isActive ? ' active' : '')}>
          <Ico name={t.icon} size={22} />
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
