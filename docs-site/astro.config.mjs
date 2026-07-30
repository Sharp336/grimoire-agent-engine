// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://nibblebot.github.io',
	base: '/oh-my-pi/',
	integrations: [
		starlight({
			title: 'omp',
			description: 'Documentation for omp, the coding agent with the IDE wired in.',
			logo: {
				src: './src/assets/logo.svg',
			},
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/can1357/oh-my-pi' }],
			components: {
				PageTitle: './src/components/PageTitle.astro',
			},
			editLink: {
				baseUrl: 'https://github.com/nibblebot/oh-my-pi/edit/docs/docs-site/',
			},
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Installation', slug: 'getting-started/installation' },
						{ label: 'Quickstart', slug: 'getting-started/quickstart' },
						{ label: 'Your First Session', slug: 'getting-started/first-session' },
					],
				},
				{
					label: 'Configuration',
					items: [
						{ label: 'Settings', slug: 'configuration/settings' },
						{ label: 'Environment Variables', slug: 'configuration/environment-variables' },
						{ label: 'Keybindings', slug: 'configuration/keybindings' },
						{ label: 'Themes', slug: 'configuration/themes' },
						{ label: 'Context Files & Rules', slug: 'configuration/context-files' },
						{ label: 'System Prompt', slug: 'configuration/system-prompt' },
						{ label: 'Approval Modes', slug: 'configuration/approvals' },
					],
				},
				{
					label: 'Models & Providers',
					items: [
						{ label: 'Providers', slug: 'models/providers' },
						{ label: 'Model Roles & Routing', slug: 'models/model-roles' },
						{ label: 'Local Models', slug: 'models/local-models' },
					],
				},
				{
					label: 'Features',
					items: [
						{ label: 'Sessions', slug: 'features/sessions' },
						{ label: 'Compaction', slug: 'features/compaction' },
						{ label: 'Memory', slug: 'features/memory' },
						{ label: 'Built-in Tools', slug: 'features/tools' },
						{ label: 'Code Execution', slug: 'features/code-execution' },
						{ label: 'Code Intelligence', slug: 'features/code-intelligence' },
						{ label: 'Debugging', slug: 'features/debugging' },
						{ label: 'Subagents', slug: 'features/subagents' },
						{ label: 'The Advisor', slug: 'features/advisor' },
						{ label: 'Code Review', slug: 'features/code-review' },
						{ label: 'Live Collaboration', slug: 'features/collab' },
						{ label: 'Web Search & Reading', slug: 'features/web-search' },
						{ label: 'Browser & App Automation', slug: 'features/browser' },
						{ label: 'GitHub Integration', slug: 'features/github' },
						{ label: 'Merge Conflict Resolution', slug: 'features/merge-conflicts' },
						{ label: 'Atomic Commits', slug: 'features/atomic-commits' },
						{ label: 'Stream Rules', slug: 'features/stream-rules' },
						{ label: 'Magic Keywords', slug: 'features/magic-keywords' },
						{ label: 'Vibe Mode', slug: 'features/vibe-mode' },
						{ label: 'Editor Integration', slug: 'features/editor-integration' },
						{ label: 'Voice (STT/TTS)', slug: 'features/voice' },
						{ label: 'Computer Use', slug: 'features/computer-use' },
						{ label: 'Usage Statistics', slug: 'features/stats' },
					],
				},
				{
					label: 'Extending omp',
					items: [
						{ label: 'Extensions', slug: 'extending/extensions' },
						{ label: 'Skills', slug: 'extending/skills' },
						{ label: 'MCP Servers', slug: 'extending/mcp' },
						{ label: 'Hooks', slug: 'extending/hooks' },
						{ label: 'Custom Tools', slug: 'extending/custom-tools' },
						{ label: 'Plugins & Marketplaces', slug: 'extending/plugins' },
						{ label: 'SDK & RPC', slug: 'extending/sdk' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'CLI Reference', slug: 'reference/cli' },
						{ label: 'Slash Commands', slug: 'reference/slash-commands' },
						{ label: 'Configuration Reference', slug: 'reference/configuration' },
					],
				},
			],
		}),
	],
});
