/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import {
  Alert,
  AppShell,
  Badge,
  Content,
  NavItem,
  Segmented,
  Sidebar,
  Topbar,
  useTheme,
  type ThemePreference,
} from '@shoots/ui';
import { api } from './api/client.js';
import type { AppInfo } from './contract.js';
import { HealthScreen } from './health/HealthScreen.js';
import { useHashRoute } from './hooks/useHashRoute.js';
import { useHeartbeat } from './hooks/useHeartbeat.js';
import { LibraryScreen } from './library/LibraryScreen.js';

const ROUTES = ['library', 'setup'] as const;
const TITLES: Record<(typeof ROUTES)[number], string> = { library: 'Library', setup: 'Setup' };

export function App() {
  const route = useHashRoute(ROUTES);
  const connected = useHeartbeat();
  const [theme, setTheme] = useTheme();
  const [info, setInfo] = useState<AppInfo>();

  useEffect(() => {
    api.info().then(setInfo, () => {});
  }, []);

  return (
    <AppShell
      sidebar={
        <Sidebar
          meta={info?.version}
          footer={
            <Segmented<ThemePreference>
              label="Theme"
              value={theme}
              onChange={setTheme}
              class="app-theme"
              options={[
                { value: 'system', label: 'Auto' },
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
              ]}
            />
          }
        >
          <NavItem icon="grid" href="#library" active={route === 'library'}>
            Library
          </NavItem>
          <NavItem icon="settings" href="#setup" active={route === 'setup'}>
            Setup
          </NavItem>
        </Sidebar>
      }
    >
      <Topbar title={TITLES[route]}>
        <span class="sh-spacer" />
        {connected ? (
          <Badge tone="success" dot>
            Connected to Lightroom
          </Badge>
        ) : (
          <Badge tone="danger" dot>
            Disconnected
          </Badge>
        )}
      </Topbar>
      <Content>
        <div class="app-page">
          {!connected && (
            <Alert tone="danger" title="The app has stopped">
              It stops when Lightroom closes or the app is closed from the plug-in. Open it again from Library › Plug-in Extras › Open shoots.
            </Alert>
          )}
          {route === 'library' ? <LibraryScreen windows={info?.platform === 'win32'} /> : <HealthScreen info={info} />}
        </div>
      </Content>
    </AppShell>
  );
}
