import { useState, useEffect, useCallback } from 'react';

interface DbStatus {
  status: 'checking' | 'connected' | 'disconnected';
  latencyMs?: number;
  error?: string;
}

export function useDbStatus() {
  const [dbStatus, setDbStatus] = useState<DbStatus>({ status: 'checking' });

  const refresh = useCallback(async () => {
    setDbStatus({ status: 'checking' });

    try {
      const res = await fetch('/api/health/db');
      const data = await res.json();

      if (res.ok) {
        setDbStatus({ status: 'connected', latencyMs: data.latencyMs });
      } else {
        setDbStatus({ status: 'disconnected', error: data.error });
      }
    } catch (err) {
      setDbStatus({
        status: 'disconnected',
        error: err instanceof Error ? err.message : 'Failed to reach server',
      });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ...dbStatus, refresh };
}
