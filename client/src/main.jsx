import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';

// Self-hosted, latin + latin-ext only. See fonts.css for why.
import './fonts.css';
import Layout from './components/Layout';
import LibraryPage from './pages/LibraryPage';
import ShowPage from './pages/ShowPage';
import MoviePage from './pages/MoviePage';
import UpNextPage from './pages/UpNextPage';
import MissingPage from './pages/MissingPage';
import StatsPage from './pages/StatsPage';
import WrappedPage from './pages/WrappedPage';
import OrganizePage from './pages/OrganizePage';
import SettingsPage from './pages/SettingsPage';
import WelcomePage from './pages/WelcomePage';
import { applyTheme, loadTheme } from './themes';
import './index.css';

// Before first paint, so a saved theme never flashes the default, and so
// pages outside the app shell (the setup guide) use it too.
applyTheme(loadTheme());

const router = createBrowserRouter([
  { path: '/welcome', element: <WelcomePage /> },
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <LibraryPage /> },
      { path: 'show/:id', element: <ShowPage /> },
      { path: 'movie/:id', element: <MoviePage /> },
      { path: 'up-next', element: <UpNextPage /> },
      { path: 'missing', element: <MissingPage /> },
      { path: 'stats', element: <StatsPage /> },
      { path: 'wrapped', element: <WrappedPage /> },
      { path: 'organize', element: <OrganizePage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
