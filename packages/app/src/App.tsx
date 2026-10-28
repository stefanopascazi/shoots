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
import { api, type StartState } from './api/client.js';
import type { AppInfo } from './contract.js';
import { HealthScreen } from './health/HealthScreen.js';
import { useHashRoute } from './hooks/useHashRoute.js';
import { useHeartbeat } from './hooks/useHeartbeat.js';
import { useLightroomError } from './hooks/useLightroomError.js';
import { LightroomErrorAlert } from './LightroomErrorAlert.js';
import { useSettings } from './hooks/useSettings.js';
import { LibraryScreen } from './library/LibraryScreen.js';
import { TrainingScreen } from './training/TrainingScreen.js';

const ROUTES = ['library', 'training', 'setup'] as const;
const TITLES: Record<(typeof ROUTES)[number], string> = { library: 'Library', training: 'Training', setup: 'Setup' };

/** Loads what the server remembers, then shows the app as it was left. */
export function App() {
  const [start, setStart] = useState<StartState>();
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    api.start().then(setStart, (e: Error) => setFailed(e.message));
  }, []);
  if (failed) {
    return (
      <div class="app-boot">
        <Alert tone="danger" title="shoots could not start">
          {failed}
        </Alert>
      </div>
    );
  }
  return start ? <Shell start={start} /> : <div class="app-boot" />;
}

function Shell({ start }: { start: StartState }) {
  const route = useHashRoute(ROUTES);
  const connected = useHeartbeat();
  const lightroom = useLightroomError();
  const prefs = useSettings(start.settings);
  const [theme, setTheme] = useTheme();
  const [info, setInfo] = useState<AppInfo>();

  useEffect(() => {
    api.info().then(setInfo, () => {});
    // The saved theme wins over whatever this browser last showed.
    setTheme(start.settings.theme);
  }, []);

  const chooseTheme = (t: ThemePreference) => {
    setTheme(t);
    prefs.update({ theme: t });
  };

  return (
    <AppShell
      sidebar={
        <Sidebar
          meta={info?.version}
          footer={
            <Segmented<ThemePreference>
              label="Theme"
              value={theme}
              onChange={chooseTheme}
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
          <NavItem icon="sparkle" href="#training" active={route === 'training'}>
            Training
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
          {connected && lightroom.error && <LightroomErrorAlert error={lightroom.error} onDismiss={lightroom.dismiss} />}
          {route === 'library' ? (
            <LibraryScreen
              windows={navigator.platform.startsWith('Win')}
              start={{ folder: start.startFolder, recursive: start.settings.recursive, recent: start.recent }}
              prefs={prefs}
            />
          ) : route === 'training' ? (
            <TrainingScreen prefs={prefs} />
          ) : (
            <HealthScreen info={info} prefs={prefs} />
          )}
        </div>
      </Content>
    </AppShell>
  );
}
