/**
 * The `n8n-libpetri` command line: `install | uninstall | status | env | verify`
 * (`tasks/inject-plan.md` decision 11). An unknown first word falls through to `verify`, so
 * `n8n-libpetri <workflow.json>` keeps working as it did before the installer existed.
 */
import { INSTALL_COMMANDS, INSTALL_USAGE, runInstallCli, type InstallCliDeps, type InstallCommand } from '../install/cli.js';
import { runCli, USAGE as VERIFY_USAGE } from '../verify/cli.js';
import type { CliIo } from './io.js';

export const USAGE = `n8n-libpetri: an alternative intra-workflow scheduler for n8n

${INSTALL_USAGE}
${VERIFY_USAGE}
`;

const isInstallCommand = (word: string | undefined): word is InstallCommand => (INSTALL_COMMANDS as readonly string[]).includes(word ?? '');

export function dispatch(argv: readonly string[], io: CliIo, deps: InstallCliDeps = {}): number | Promise<number> {
  const [first, ...rest] = argv;
  if (isInstallCommand(first)) return runInstallCli(first, rest, io, deps);
  if (argv.length === 1 && (first === 'help' || first === '--help' || first === '-h')) {
    io.stdout(USAGE);
    return 0;
  }
  return runCli(argv, io);
}
