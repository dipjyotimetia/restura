import { useShallow } from 'zustand/react/shallow';
import { useMcpStore } from '@/features/mcp/store/useMcpStore';

export function useMcpConnectionActions() {
  return useMcpStore(
    useShallow((state) => ({
      createConnection: state.createConnection,
      setUrl: state.setUrl,
      setTransport: state.setTransport,
      addHeader: state.addHeader,
      updateHeader: state.updateHeader,
      removeHeader: state.removeHeader,
      setStatus: state.setStatus,
      setCapabilities: state.setCapabilities,
      appendLog: state.appendLog,
      clearLog: state.clearLog,
    }))
  );
}
