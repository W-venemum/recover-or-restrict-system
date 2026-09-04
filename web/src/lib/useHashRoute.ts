import { useEffect, useState } from "react";

/**
 * Minimal hash-based router. Avoids a routing dependency for a two-page demo.
 * Routes:
 *   #/                     -> dashboard
 *   #/customers            -> customer list
 *   #/customers/:id        -> customer detail
 */
export function useHashRoute(): string {
  const [hash, setHash] = useState<string>(() => window.location.hash || "#/");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash.replace(/^#/, "") || "/";
}

export function navigate(path: string): void {
  window.location.hash = path;
}
