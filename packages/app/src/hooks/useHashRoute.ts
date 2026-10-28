import { useEffect, useState } from 'preact/hooks';

/** Reads `#name` into a known route, falling back to the first one. */
export function parseRoute<T extends string>(hash: string, routes: readonly T[]): T {
  const name = hash.replace(/^#/, '');
  return (routes as readonly string[]).includes(name) ? (name as T) : routes[0];
}

export function useHashRoute<T extends string>(routes: readonly T[]): T {
  const [route, setRoute] = useState(() => parseRoute(location.hash, routes));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash, routes));
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, [routes]);
  return route;
}
