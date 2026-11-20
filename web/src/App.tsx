import { useEffect } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { api, ApiError, setUnauthorizedHandler } from './api';
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
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<{ authenticated: boolean }>('/api/auth/me'), staleTime: 5 * 60_000 });
  const loc = useLocation();
  // scroll to top on tab switch (no animation), unless jumping to an anchor
  useEffect(() => { if (!loc.hash) window.scrollTo(0, 0); }, [loc.pathname, loc.hash]);
  if (!me.data) return null;
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
    return () => setUnauthorizedHandler(null);
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
