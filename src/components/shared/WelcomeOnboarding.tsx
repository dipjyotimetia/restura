import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Rocket, Send, Globe, Code2, Keyboard, FolderOpen, ArrowRight, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/shared/utils';

interface OnboardingStep {
  icon: React.ReactNode;
  title: string;
  description: string;
  tip: string;
}

const onboardingSteps: OnboardingStep[] = [
  {
    icon: <Send className="h-7 w-7 text-primary" />,
    title: 'Send Your First Request',
    description: 'Enter a URL in the request builder and click Send to make your first API call.',
    tip: 'Press ⌘+↵ to quickly send a request',
  },
  {
    icon: <Globe className="h-7 w-7 text-emerald-400" />,
    title: 'Manage Environments',
    description: 'Create different environments (dev, staging, prod) and switch between them easily.',
    tip: 'Use {{variableName}} syntax in URLs to reference environment variables',
  },
  {
    icon: <FolderOpen className="h-7 w-7 text-amber-400" />,
    title: 'Organize with Collections',
    description: 'Save your requests into collections for easy access and sharing with your team.',
    tip: 'Import existing Postman or Insomnia collections with ⌘+I',
  },
  {
    icon: <Code2 className="h-7 w-7 text-primary" />,
    title: 'Generate Code Snippets',
    description: 'Convert any request into code in multiple languages (JavaScript, Python, Go, etc.).',
    tip: 'Click the "Code" button next to Send to generate snippets',
  },
  {
    icon: <Keyboard className="h-7 w-7 text-cyan-400" />,
    title: 'Master Keyboard Shortcuts',
    description: 'Work faster with keyboard shortcuts. Press ⌘+/ to see all available shortcuts.',
    tip: 'Use ⌘+K to open the command palette for quick actions',
  },
];

const ONBOARDING_KEY = 'restura-onboarding-completed';

export default function WelcomeOnboarding() {
  const [isOpen, setIsOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);

  useEffect(() => {
    const hasCompleted = localStorage.getItem(ONBOARDING_KEY);
    if (!hasCompleted) {
      const timer = setTimeout(() => setIsOpen(true), 500);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, []);

  const handleNext = () => {
    if (currentStep < onboardingSteps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      handleComplete();
    }
  };

  const handleComplete = () => {
    localStorage.setItem(ONBOARDING_KEY, 'true');
    setIsOpen(false);
  };

  const currentStepData = onboardingSteps[currentStep];

  if (!currentStepData) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="max-w-md bg-card border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono text-sm tracking-wide">
            <Rocket className="h-4 w-4 text-primary" />
            WELCOME TO RESTURA
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            Your modern API testing companion. Let&apos;s get you started.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {/* Progress dots */}
          <div className="flex items-center justify-center gap-1.5 mb-6">
            {onboardingSteps.map((_, idx) => (
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
            <div className="flex justify-center p-3 rounded-lg bg-surface-2 w-16 h-16 items-center mx-auto">
              {currentStepData.icon}
            </div>
            <h3 className="text-sm font-mono font-medium">{currentStepData.title}</h3>
            <p className="text-xs text-muted-foreground font-mono leading-relaxed">
              {currentStepData.description}
            </p>

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
              {currentStep + 1}/{onboardingSteps.length}
            </span>
            <Button
              variant="glow"
              size="sm"
              onClick={handleNext}
              className="font-mono text-xs"
            >
              {currentStep === onboardingSteps.length - 1 ? (
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
