# Contributing to Restura

Thank you for your interest in contributing to Restura! This document provides guidelines and information for contributors.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Coding Standards](#coding-standards)
- [Testing Guidelines](#testing-guidelines)
- [Pull Request Process](#pull-request-process)
- [Issue Reporting](#issue-reporting)

## Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md). Please read it before contributing.

## Getting Started

### Prerequisites

- **Node.js** >= 18.x
- **npm** >= 9.x
- **Git**

### Quick Start

```bash
# Clone the repository
git clone https://github.com/dipjyotimetia/restura.git
cd restura

# Install dependencies
npm install

# Start development server
npm run dev
```

## Development Setup

### Frontend (Web Client)

```bash
# Install dependencies
npm install

# Start development server with hot reload
npm run dev

# Run type checking
npm run type-check

# Run linting
npm run lint

# Run tests
npm run test

# Run all validations
npm run validate
```

### Electron Desktop App

```bash
# Development mode
npm run electron:dev

# Build for distribution
npm run electron:dist
```

## Project Structure

```
restura/
├── src/                  # Source code
│   ├── app/             # Next.js App Router pages
│   ├── components/      # React components
│   │   ├── ui/         # Base UI components (shadcn/ui)
│   │   └── *.tsx       # Feature components
│   ├── store/          # Zustand state stores
│   ├── lib/            # Utility functions
│   ├── hooks/          # Custom React hooks
│   └── types/          # TypeScript type definitions
├── electron/            # Electron main process
├── tests/              # Test files
├── scripts/            # Build scripts
└── docs/               # Documentation
```

## Development Workflow

### Branch Naming Convention

- `feature/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation updates
- `refactor/` - Code refactoring
- `test/` - Test additions or fixes
- `chore/` - Maintenance tasks

Example: `feature/add-graphql-support`

### Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, semicolons, etc.)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Examples:**
```bash
feat(auth): add OAuth 2.0 PKCE support
fix(request): resolve URL encoding issue with special characters
docs(readme): update installation instructions
test(store): add unit tests for collection store
```

## Coding Standards

### TypeScript/React

- **Strict Mode**: All code must pass strict TypeScript checks
- **Functional Components**: Use functional components with hooks
- **Named Exports**: Prefer named exports over default exports
- **Type Safety**: Use proper types, avoid `any`
- **Error Handling**: Handle all errors appropriately
- **Accessibility**: Follow WCAG 2.1 AA guidelines

```typescript
// Good
export function RequestBuilder({ onSubmit }: RequestBuilderProps) {
  const [url, setUrl] = useState<string>('');

  const handleSubmit = useCallback((e: FormEvent) => {
    e.preventDefault();
    onSubmit(url);
  }, [url, onSubmit]);

  return (
    <form onSubmit={handleSubmit} aria-label="Request builder">
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        aria-label="Request URL"
      />
    </form>
  );
}

// Bad
export default function RequestBuilder(props: any) {
  const [url, setUrl] = useState('');
  // Missing proper typing and accessibility
}
```

### State Management

- Use Zustand stores for global state
- Keep state as local as possible
- Use selectors to prevent unnecessary re-renders
- Validate state with Zod schemas

```typescript
// Good - Selective subscription
const url = useRequestStore((state) => state.url);

// Bad - Full store subscription (causes re-renders)
const store = useRequestStore();
```

### CSS/Styling

- Use Tailwind CSS utility classes
- Follow mobile-first responsive design
- Use CSS variables for theming
- Avoid inline styles

```tsx
// Good
<div className="flex flex-col gap-4 p-4 md:flex-row lg:gap-6">
  <Button variant="default" size="sm">
    Submit
  </Button>
</div>

// Bad
<div style={{ display: 'flex', padding: '16px' }}>
  <button style={{ backgroundColor: 'blue' }}>Submit</button>
</div>
```

## Testing Guidelines

### Frontend Testing

We use Vitest with React Testing Library:

```typescript
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { RequestBuilder } from './RequestBuilder';

describe('RequestBuilder', () => {
  it('should update URL on input change', () => {
    render(<RequestBuilder />);

    const input = screen.getByLabelText(/url/i);
    fireEvent.change(input, { target: { value: 'https://api.example.com' } });

    expect(input).toHaveValue('https://api.example.com');
  });

  it('should call onSubmit with request data', () => {
    const mockSubmit = vi.fn();
    render(<RequestBuilder onSubmit={mockSubmit} />);

    // Test implementation
  });
});
```

### Test Organization

```
src/
├── store/
│   └── __tests__/
│       └── useRequestStore.test.ts
├── lib/
│   └── __tests__/
│       └── validations.test.ts
└── components/
    └── __tests__/
        └── RequestBuilder.test.tsx

tests/
├── unit/              # Unit tests
├── integration/       # Integration tests
└── fixtures/          # Test data
```

### Coverage Requirements

- Minimum 80% code coverage for new features
- All critical paths must be tested
- Include unit, integration, and accessibility tests

### Running Tests

```bash
# Run all tests
npm run test

# Run tests in watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage

# Run specific test file
npm run test -- RequestBuilder.test.tsx
```

## Pull Request Process

### Before Submitting

1. **Update your branch** with the latest main:
   ```bash
   git fetch origin
   git rebase origin/main
   ```

2. **Run all validations**:
   ```bash
   npm run validate
   ```

3. **Ensure tests pass**:
   ```bash
   npm run test:run
   ```

4. **Check for type errors**:
   ```bash
   npm run type-check
   ```

5. **Lint your code**:
   ```bash
   npm run lint
   ```

### PR Checklist

- [ ] Code follows project coding standards
- [ ] Tests added/updated for changes
- [ ] Documentation updated if needed
- [ ] No console.log statements left in code
- [ ] No commented-out code
- [ ] Commits follow conventional commit format
- [ ] PR description clearly explains changes
- [ ] Screenshots/videos for UI changes
- [ ] Breaking changes documented

### PR Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## How Has This Been Tested?
Describe testing approach

## Screenshots (if applicable)
Add screenshots

## Checklist
- [ ] My code follows the style guidelines
- [ ] I have performed a self-review
- [ ] I have commented my code where necessary
- [ ] I have updated documentation
- [ ] My changes generate no new warnings
- [ ] I have added tests
- [ ] All tests pass locally
```

### Review Process

1. Submit PR against `main` branch
2. Automated CI checks must pass
3. At least one maintainer approval required
4. All conversations must be resolved
5. Squash and merge with meaningful commit message

## Issue Reporting

### Bug Reports

Include:
- Clear, descriptive title
- Steps to reproduce
- Expected behavior
- Actual behavior
- Environment details (OS, browser, Node version)
- Screenshots/logs if applicable

### Feature Requests

Include:
- Use case description
- Proposed solution
- Alternative solutions considered
- Additional context

### Issue Labels

- `bug` - Something isn't working
- `enhancement` - New feature request
- `documentation` - Documentation improvements
- `good first issue` - Good for newcomers
- `help wanted` - Extra attention needed
- `priority: high` - Critical issues
- `priority: low` - Nice to have

## Additional Resources

- [Architecture Documentation](docs/ARCHITECTURE.md)
- [Security Policy](SECURITY.md)
- [Project Roadmap](docs/ROADMAP.md)
- [API Reference](docs/API.md)

## Questions?

Feel free to:
- Open an issue for questions
- Start a discussion
- Reach out to maintainers

Thank you for contributing to Restura! Your efforts help make this project better for everyone.
