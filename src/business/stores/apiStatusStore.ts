import { create } from 'zustand';
import type { HealthCheckData } from '@sudobility/types';

/**
 * Placeholder Zustand store: remembers the last health check result.
 *
 * Shows the store pattern for this package — plain state plus setter
 * actions, no network calls (those live in raidr_agent_client).
 */
export interface ApiStatusState {
  lastHealth: HealthCheckData | null;
  lastCheckedAt: number | null;
  setHealth: (health: HealthCheckData | null) => void;
  reset: () => void;
}

export const useApiStatusStore = create<ApiStatusState>(set => ({
  lastHealth: null,
  lastCheckedAt: null,
  setHealth: health => set({ lastHealth: health, lastCheckedAt: Date.now() }),
  reset: () => set({ lastHealth: null, lastCheckedAt: null }),
}));
