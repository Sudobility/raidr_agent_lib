import { useEffect } from 'react';
import { useHealth } from '@sudobility/raidr_agent_client';
import type { Optional } from '@sudobility/raidr_agent_types';
import type { HealthCheckData, NetworkClient } from '@sudobility/types';
import { useApiStatusStore } from '../stores/apiStatusStore';

export interface UseApiStatusReturn {
  health: HealthCheckData | null;
  isHealthy: boolean;
  isLoading: boolean;
  error: Optional<string>;
  refresh: () => void;
}

/**
 * Placeholder business hook: composes the client's `useHealth` query with
 * the {@link useApiStatusStore} store. Domain hooks in this package follow
 * the same shape — client hook for data, store for app-side state.
 */
export const useApiStatus = (
  networkClient: NetworkClient,
  baseUrl: string,
  options?: { enabled?: boolean }
): UseApiStatusReturn => {
  const { health, isLoading, error, update } = useHealth(
    networkClient,
    baseUrl,
    options
  );
  const setHealth = useApiStatusStore(s => s.setHealth);

  useEffect(() => {
    if (health) setHealth(health);
  }, [health, setHealth]);

  return {
    health,
    isHealthy: health?.status === 'ok',
    isLoading,
    error,
    refresh: update,
  };
};
