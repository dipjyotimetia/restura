'use client';

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Rocket, Send, Globe, Code2, Keyboard, FolderOpen, ArrowRight, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface OnboardingStep {
  icon: React.ReactNode;
  title: string;
  description: string;
  tip: string;
}

const onboardingSteps: OnboardingStep[] = [
  {
    icon: <Send className="h-8 w-8 text-slate-blue-500" />,
    title: 'Send Your First Request',
    description: 'Enter a URL in the request builder and click Send to make your first API call.',
    tip: 'Pro tip: Press ⌘+↵ to quickly send a request',
  },
  {
    icon: <Globe className="h-8 w-8 text-emerald-500" />,
    title: 'Manage Environments',
    description: 'Create different environments (dev, staging, prod) and switch between them easily.',
    tip: 'Use {{variableName}} syntax in URLs to reference environment variables',
  },
  {
    icon: <FolderOpen className="h-8 w-8 text-amber-500" />,
    title: 'Organize with Collections',
    description: 'Save your requests into collections for easy access and sharing with your team.',
    tip: 'Import existing Postman or Insomnia collections with ⌘+I',
  },
  {
    icon: <Code2 className="h-8 w-8 text-purple-500" />,
    title: 'Generate Code Snippets',
    description: 'Convert any request into code in multiple languages (JavaScript, Python, Go, etc.).',
    tip: 'Click the "Code" button next to Send to generate snippets',
  },
  {
    icon: <Keyboard className="h-8 w-8 text-indigo-500" />,
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
    // Check if onboarding has been completed
    const hasCompleted = localStorage.getItem(ONBOARDING_KEY);
    if (!hasCompleted) {
      // Small delay to let the app render first
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

  const handleSkip = () => {
    handleComplete();
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
      <DialogContent className="max-w-lg glass">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <Rocket className="h-6 w-6 text-slate-blue-500" />
            Welcome to Restura
          </DialogTitle>
          <DialogDescription>
            Your modern API testing companion. Let&apos;s get you started with the basics.
          </DialogDescription>
        </DialogHeader>

        <div className="py-6">
          {/* Progress indicator */}
          <div className="flex items-center justify-center gap-2 mb-6">
            {onboardingSteps.map((_, idx) => (
              <div
                key={idx}
                className={cn(
                  'h-2 rounded-full transition-all duration-300',
                  idx === currentStep ? 'w-8 bg-slate-blue-500' : 'w-2 bg-slate-200 dark:bg-slate-700',
                  idx < currentStep && 'bg-emerald-500'
                )}
              />
            ))}
          </div>

          {/* Step content */}
          <div className="text-center space-y-4">
            <div className="flex justify-center">{currentStepData.icon}</div>
            <h3 className="text-lg font-semibold">{currentStepData.title}</h3>
            <p className="text-sm text-muted-foreground">{currentStepData.description}</p>

            {/* Tip box */}
            <div className="bg-slate-blue-50 dark:bg-slate-blue-950/30 border border-slate-blue-200 dark:border-slate-blue-800 rounded-lg p-3 mt-4">
              <p className="text-xs text-slate-blue-700 dark:text-slate-blue-300 flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                {currentStepData.tip}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <Button variant="ghost" onClick={handleSkip} className="text-muted-foreground">
            Skip Tour
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {currentStep + 1} of {onboardingSteps.length}
            </span>
            <Button onClick={handleNext} className="bg-slate-blue-600 hover:bg-slate-blue-700">
              {currentStep === onboardingSteps.length - 1 ? (
                'Get Started'
              ) : (
                <>
                  Next
                  <ArrowRight className="ml-2 h-4 w-4" />
                </>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
