import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

import { pinCliTelemetryEndpoint } from '../agentTelemetry.js';

describe('pinCliTelemetryEndpoint', () => {
  beforeEach(() => lookupMock.mockReset());

  it('pins a public hostname to its single validated address', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    const pinned = await pinCliTelemetryEndpoint('https://collector.example.test/v1/traces');

    expect(pinned).toEqual({ host: 'collector.example.test', ip: '93.184.216.34' });
  });

  it.each([
    ['loopback', [{ address: '127.0.0.1', family: 4 }]],
    ['RFC1918', [{ address: '10.0.0.5', family: 4 }]],
    ['cloud metadata', [{ address: '169.254.169.254', family: 4 }]],
    [
      'a mixed public+private answer',
      [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
    ],
  ])('refuses a hostname that resolves to %s', async (_name, records) => {
    lookupMock.mockResolvedValue(records);

    await expect(
      pinCliTelemetryEndpoint('https://collector.example.test/v1/traces')
    ).rejects.toThrow();
  });

  it('allows loopback only for an explicit loopback collector, never via a hostname', async () => {
    await expect(pinCliTelemetryEndpoint('http://127.0.0.1:4318/v1/traces')).resolves.toEqual({
      host: '127.0.0.1',
      ip: '127.0.0.1',
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
