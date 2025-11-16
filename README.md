# Restura

⚡ Fast, lightweight API client supporting REST, GraphQL, gRPC & more. Built for developers who value speed and simplicity.

**RESTURA** is a full-featured API client that makes testing and debugging APIs effortless. Whether you're working with REST, GraphQL, gRPC, or WebSockets, RESTURA provides an intuitive interface with powerful features that developers actually need.

## ✨ Why RESTURA?

- 🚀 **Multi-protocol support**: HTTP/REST, GraphQL, gRPC, WebSockets, and more
- ⚡ **Lightning fast**: Built with performance in mind
- 🔒 **Privacy-first**: Your data stays on your machine
- 🎨 **Beautiful UI**: Clean, modern interface that doesn't get in your way
- 🔌 **Extensible**: Plugin system for custom functionality
- 💻 **Cross-platform**: Works on macOS, Windows, and Linux
- 🆓 **Forever free**: No premium tiers, no feature gates

### Desktop Client (Electron)

All web features plus:
- Native file system access
- Application menu integration
- Window state persistence
- Cross-platform (Windows, macOS, Linux)

## Tech Stack

- **Framework**: Next.js 16 with App Router
- **UI**: React 19, TailwindCSS 4, shadcn/ui
- **State**: Zustand with persistence
- **Validation**: Zod schemas
- **Editor**: Monaco Editor
- **Testing**: Vitest + React Testing Library

## Quick Start

### Prerequisites

- Node.js 22+

### Web Client

```bash
# Clone the repository
git clone https://github.com/dipjyotimetia/restura.git
cd restura

# Install dependencies
npm install

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Desktop App

```bash
# Development mode
npm run electron:dev

# Build for distribution
npm run electron:dist:mac    # macOS
npm run electron:dist:win    # Windows
npm run electron:dist:linux  # Linux
```

## Project Structure

```
restura/
├── src/                  # Source code
│   ├── app/             # Next.js App Router
│   ├── components/      # React components (feature + UI)
│   ├── store/          # Zustand state stores
│   ├── lib/            # Utilities and helpers
│   ├── hooks/          # Custom React hooks
│   └── types/          # TypeScript type definitions
├── electron/            # Electron main process
│   ├── main/           # Main process code
│   ├── types/          # Electron-specific types
│   └── resources/      # App icons and assets
├── tests/              # Test files
│   ├── unit/           # Unit tests
│   ├── integration/    # Integration tests
│   └── fixtures/       # Test data
├── scripts/            # Build and utility scripts
├── docs/               # Project documentation
└── [config files]      # Root-level configurations
```

## Development

### Scripts

```bash
# Web Client
npm run dev              # Start dev server
npm run build           # Production build
npm run lint            # ESLint check
npm run lint:fix        # Fix lint issues
npm run format          # Format with Prettier
npm run type-check      # TypeScript check
npm run test            # Run tests
npm run test:coverage   # Test coverage
npm run validate        # Full validation

# Electron
npm run electron:dev    # Development mode
npm run electron:dist   # Build distribution
```

### Code Quality

- **TypeScript**: Strict mode with comprehensive checks
- **ESLint**: Next.js + TypeScript rules
- **Prettier**: Consistent code formatting
- **Husky**: Pre-commit hooks
- **lint-staged**: Format staged files

### Testing

```bash
# Run all tests
npm run test:run

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage

# UI mode
npm run test:ui
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) - System design and architecture
- [API Reference](docs/API.md) - Internal APIs and types
- [Development Standards](docs/DEVELOPMENT_STANDARDS.md) - Coding standards
- [Contributing](CONTRIBUTING.md) - Contribution guidelines
- [Security](SECURITY.md) - Security policy
- [Code of Conduct](CODE_OF_CONDUCT.md) - Community guidelines

## Contributing

We welcome contributions! Please see our [Contributing Guidelines](CONTRIBUTING.md) for details.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Security

For security concerns, please review our [Security Policy](SECURITY.md) and report vulnerabilities responsibly.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [shadcn/ui](https://ui.shadcn.com/) - Beautiful UI components
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) - Code editor
- [Radix UI](https://www.radix-ui.com/) - Accessible primitives
- [Zustand](https://github.com/pmndrs/zustand) - State management

---

Made with love by [dipjyotimetia](https://github.com/dipjyotimetia)
