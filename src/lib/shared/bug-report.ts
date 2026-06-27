import { getAppVersion, getPlatform, openExternalUrl } from './platform';

function osHint(platform: string): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  // Web — sniff from UA (best-effort, no library needed)
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (ua.includes('Mac')) return 'macOS';
  if (ua.includes('Win')) return 'Windows';
  if (ua.includes('Linux')) return 'Linux';
  return '';
}

export async function openBugReport(): Promise<void> {
  const version = await getAppVersion();
  const platform = getPlatform();
  const electron = platform !== 'web';
  const os = osHint(platform);

  // Mirrors .github/ISSUE_TEMPLATE/bug_report.md — pre-fill known fields.
  const body = [
    '## Bug Description',
    '',
    '<!-- A clear and concise description of what the bug is -->',
    '',
    '## Steps to Reproduce',
    '',
    "1. Go to '...'",
    "2. Click on '...'",
    "3. Scroll down to '...'",
    '4. See error',
    '',
    '## Expected Behavior',
    '',
    '<!-- A clear and concise description of what you expected to happen -->',
    '',
    '## Actual Behavior',
    '',
    '<!-- A clear and concise description of what actually happened -->',
    '',
    '## Screenshots',
    '',
    '<!-- If applicable, add screenshots to help explain your problem -->',
    '',
    '## Environment',
    '',
    '**Desktop (please complete the following information):**',
    '',
    `- OS: ${os || '[e.g. macOS 14.0, Windows 11, Ubuntu 22.04]'}`,
    '- Browser: [e.g. Chrome 120, Firefox 121, Safari 17]',
    '- Node Version: [e.g. 20.10.0]',
    `- Restura Version: v${version}`,
    '',
    '**Application Type:**',
    '',
    `- [${electron ? 'x' : ' '}] Electron Desktop App`,
    `- [${electron ? ' ' : 'x'}] Web Client`,
    '',
    '## Console Errors',
    '',
    '```',
    'Paste error logs here',
    '```',
    '',
    '## Additional Context',
    '',
    '<!-- Add any other context about the problem here -->',
    '',
    '## Possible Solution',
    '',
    '<!-- If you have suggestions on how to fix the issue, please describe them -->',
  ].join('\n');

  const url =
    'https://github.com/dipjyotimetia/restura/issues/new?' +
    new URLSearchParams({ labels: 'bug', title: '[BUG] ', body }).toString();

  await openExternalUrl(url);
}
