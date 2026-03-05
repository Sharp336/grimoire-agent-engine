# Contributing to Oh My Pi

Thank you for your interest in contributing! Here's how to get started.

## Development Setup

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0
- [Rust](https://rustup.rs/) (for native modules)
- Node.js 18+

### Getting Started

```bash
# Clone the repository
git clone https://github.com/can1357/oh-my-pi.git
cd oh-my-pi

# Install dependencies
bun install

# Run in development mode
bun run dev
```

## Making Changes

1. **Fork** the repository
2. **Create a branch** from `main`: `git checkout -b fix/my-fix`
3. **Make your changes** and ensure tests pass
4. **Commit** with a clear message following [Conventional Commits](https://www.conventionalcommits.org/)
5. **Push** and open a Pull Request

## Code Style

- TypeScript: Follow the existing ESLint configuration
- Rust: Use `cargo fmt` and `cargo clippy`

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Include reproduction steps and environment details

## License

By contributing, you agree that your contributions will be licensed under the project's existing license.
