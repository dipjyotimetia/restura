import {
  Rocket,
  Send,
  Globe,
  Code2,
  Keyboard,
  FolderOpen,
  ArrowRight,
  CheckCircle2,
  ShieldCheck,
  Network,
  Sparkles,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { ToggleField } from '@/components/ui/spatial/ToggleField';
import { isElectron } from '@/lib/shared/platform';
import { secureStorage } from '@/lib/shared/secure-storage';
import { cn } from '@/lib/shared/utils';
import { useSettingsStore } from '@/store/useSettingsStore';

interface OnboardingStep {
  icon: React.ReactNode;
  title: string;
  description: string;
  tip: string;
  // 'privacy' renders an inline telemetry opt-out toggle below the description.
  kind?: 'privacy';
  // Steps for desktop-only features (e.g. the AI assistant) are filtered out on web.
  desktopOnly?: boolean;
}

const onboardingSteps: OnboardingStep[] = [
  {
    icon: <Send className="h-7 w-7 text-primary" />,
    title: 'Send Your First Request',
    description: 'Enter a URL in the request builder and click Send to make your first API call.',
    tip: 'Press ⌘+↵ to quickly send a request',
  },
  {
    icon: <Network className="h-7 w-7 text-violet-400" />,
    title: 'One Client, Every Protocol',
    description:
      'Restura is more than REST — test gRPC, GraphQL, WebSocket, Socket.IO, SSE, and MCP, plus Kafka and MQTT on desktop.',
    tip: 'Open ⌘+K → "New …" to start a request in any protocol',
  },
  {
    desktopOnly: true,
    icon: <Sparkles className="h-7 w-7 text-fuchsia-400" />,
    title: 'Ask the AI Assistant',
    description:
      'Chat with an AI that can read your current request and response to help debug failures, explain errors, and draft payloads.',
    tip: 'Your context is redacted — secrets and credentials are scrubbed before anything is sent',
  },
  {
    icon: <Globe className="h-7 w-7 text-emerald-400" />,
    title: 'Manage Environments',
    description:
      'Create different environments (dev, staging, prod) and switch between them easily.',
    tip: 'Use {{variableName}} syntax in URLs to reference environment variables',
  },
  {
    icon: <FolderOpen className="h-7 w-7 text-amber-400" />,
    title: 'Organize with Collections',
    description: 'Save your requests into collections for easy access and sharing with your team.',
    tip: 'Import from Postman, Insomnia, OpenAPI or Bruno via ⌘+K → "Import collection"',
  },
  {
    icon: <Code2 className="h-7 w-7 text-primary" />,
    title: 'Generate Code Snippets',
    description:
      'Convert any request into code in multiple languages (cURL, Python, JavaScript, Go, and more).',
    tip: 'Click the </> icon next to Send, or run "Generate code" from ⌘+K',
  },
  {
    icon: <Keyboard className="h-7 w-7 text-cyan-400" />,
    title: 'Master Keyboard Shortcuts',
    description: 'Work faster with keyboard shortcuts. Press ⌘+/ to see all available shortcuts.',
    tip: 'Use ⌘+K to open the command palette for quick actions',
  },
  {
    kind: 'privacy',
    icon: <ShieldCheck className="h-7 w-7 text-emerald-400" />,
    title: 'Help Improve Restura',
    description:
      'Anonymous crash & error reports help us fix bugs. Only the error message, stack, app version, and browser/OS info are sent — never your requests, URLs, headers, or response bodies.',
    tip: 'Change this anytime in Settings → Privacy.',
  },
];

const ONBOARDING_KEY = 'restura-onboarding-completed';

export default function WelcomeOnboarding() {
  const [isOpen, setIsOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const telemetryEnabled = useSettingsStore((s) => s.settings.telemetry?.errorsEnabled ?? true);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  // AI is Electron-only; drop desktop-only steps on web so users aren't shown
  // features they can't use. isElectron() is constant per session.
  const steps = useMemo(
    () => onboardingSteps.filter((step) => !step.desktopOnly || isElectron()),
    []
  );

  useEffect(() => {
    // secureStorage wraps localStorage with try/catch (private mode / disabled
    // storage → null), so we don't hand-roll the guard here.
    const hasCompleted = secureStorage.get(ONBOARDING_KEY);
    if (!hasCompleted) {
      const timer = setTimeout(() => setIsOpen(true), 500);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, []);

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      handleComplete();
    }
  };

  const handleComplete = () => {
    secureStorage.set(ONBOARDING_KEY, 'true');
    setIsOpen(false);
  };

  const currentStepData = steps[currentStep];

  if (!currentStepData) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader icon={Rocket}>
          <DialogTitle>WELCOME TO RESTURA</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            Your modern API testing companion. Let&apos;s get you started.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {/* Progress dots */}
          <div className="flex items-center justify-center gap-1.5 mb-6">
            {steps.map((_, idx) => (
              <div
                key={idx}
                className={cn(
                  'h-1.5 rounded-full transition-all duration-300',
                  idx === currentStep
                    ? 'w-6 bg-primary'
                    : idx < currentStep
                      ? 'w-1.5 bg-emerald-400'
                      : 'w-1.5 bg-border'
                )}
                aria-hidden="true"
              />
            ))}
          </div>

          {/* Step content */}
          <div className="text-center space-y-3">
            <div className="flex justify-center p-3 rounded-lg bg-sp-surface-hi border border-sp-line w-16 h-16 items-center mx-auto">
              {currentStepData.icon}
            </div>
            <h3 className="text-sm font-mono font-medium">{currentStepData.title}</h3>
            <p className="text-xs text-muted-foreground font-mono leading-relaxed">
              {currentStepData.description}
            </p>

            {/* Inline telemetry opt-out (privacy step only) */}
            {currentStepData.kind === 'privacy' && (
              <div className="flex items-center justify-between gap-3 rounded border border-border bg-muted/30 p-3 mt-3 text-left">
                <span className="text-xs font-mono">Send crash &amp; error reports</span>
                <ToggleField
                  checked={telemetryEnabled}
                  onChange={(v) => updateSettings({ telemetry: { errorsEnabled: v } })}
                  ariaLabel="Send crash and error reports"
                />
              </div>
            )}

            {/* Tip box */}
            <div className="bg-primary/5 border border-primary/20 rounded p-3 mt-3 text-left">
              <p className="text-xs text-primary font-mono flex items-start gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                {currentStepData.tip}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleComplete}
            className="text-muted-foreground font-mono text-xs"
          >
            Skip Tour
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-muted-foreground">
              {currentStep + 1}/{steps.length}
            </span>
            <Button variant="glow" size="sm" onClick={handleNext} className="font-mono text-xs">
              {currentStep === steps.length - 1 ? (
                'Get Started'
              ) : (
                <>
                  Next
                  <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                </>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
