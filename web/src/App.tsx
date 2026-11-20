import { useEffect } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, setPasswordChangeHandler, setUnauthorizedHandler } from './api';
import { useMe } from './hooks';
import { ChangePasswordScreen } from './components/ChangePassword';
import type { Me } from './types';
import { TabBar } from './components/TabBar';
import Login from './screens/Login';
import Home from './screens/Home';
import Activity from './screens/Activity';
import Budgets from './screens/Budgets';
import Wealth from './screens/Wealth';
import { PlaidProvider } from './plaid';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: true,
      retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2,
    },
  },
});

function Shell() {
  const me = useMe();
  const loc = useLocation();
  // scroll to top on tab switch (no animation), unless jumping to an anchor
  useEffect(() => { if (!loc.hash) window.scrollTo(0, 0); }, [loc.pathname, loc.hash]);
  if (!me.data) return null;
  if (me.data.mustChangePassword) return <ChangePasswordScreen />;
  return (
    <>
      <Outlet />
      <TabBar />
    </>
  );
}

function Routing() {
  const nav = useNavigate();
  useEffect(() => {
    setUnauthorizedHandler(() => {
      queryClient.clear();
      if (window.location.pathname !== '/login') nav('/login', { replace: true });
    });
    setPasswordChangeHandler(() => {
      queryClient.setQueryData<Me>(['me'], (m) => (m ? { ...m, mustChangePassword: true } : m));
    });
    return () => { setUnauthorizedHandler(null); setPasswordChangeHandler(null); };
  }, [nav]);
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Shell />}>
        <Route index element={<Home />} />
        <Route path="activity" element={<Activity />} />
        <Route path="budgets" element={<Budgets />} />
        <Route path="wealth" element={<Wealth />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <PlaidProvider>
          <Routing />
        </PlaidProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
