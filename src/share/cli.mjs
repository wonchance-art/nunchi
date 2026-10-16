// `nunchi share` in the CLI (spec §7.6). What the agent may run: `share` (send now, as the person set it up), `share
// --status` and `share --off`. What only the person may run, in their own terminal (a TTY, a code typed back; the
// deny hook refuses both from the agent): `share --setup` and `share --on`.
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { share, shareStatus } from './send.mjs';
import { setupShare, turnOnShare, offShare } from './setup.mjs';
import { terminalCommand } from '../setup.mjs';
import { LEDGER_ERRORS } from '../project.mjs';

export const PERSON_ONLY = cmd => `Sharing is turned on only in your own terminal: ${terminalCommand()} share ${cmd}`;
// the person's terminal: one readline for the whole dialog
function terminal() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let closed = false;
  rl.on('close', () => { closed = true; });
  return {
    say: l => process.stdout.write(`${l}\n`),
    ask: q => new Promise(res => { if (closed) return res(null); const onClose = () => res(null); rl.once('close', onClose); rl.question(q, a => { rl.off('close', onClose); res(a); }); }),
    close: () => rl.close(),
  };
}
export async function shareCommand(args, { version, flagsOutside }) {
  const usage = m => { console.error(`nunchi share: ${m}`); process.exit(1); };
  // no --root: the pack is of this project's runs and ledger, as set up here (the setup is per project and worktree)
  const outside = flagsOutside(args, ['setup', 'on', 'off', 'status', 'run', 'json', 'fromChat']);
  if (outside.length) usage(`${outside.join(', ')}: not a flag of share (nunchi share [--run <id>] [--json] | --status | --off | --setup | --on)`);
  if (args._.length > 1) usage(`unexpected ${JSON.stringify(args._[1])} (nunchi share [--run <id>] [--json] | --status | --off | --setup | --on)`);
  const modes = ['setup', 'on', 'off', 'status'].filter(k => args[k]);
  if (modes.length > 1) usage(`use one of --setup, --on, --off or --status`);
  if ('run' in args && (typeof args.run !== 'string' || !/^\d{4,}$/.test(args.run))) usage('--run takes a run id (0007)');
  const project = process.cwd(), nunchiDir = resolve('.nunchi'), root = project;
  const tty = !!(process.stdin.isTTY && process.stdout.isTTY) && !args.fromChat;
  try {
    if (args.setup || args.on) {
      if (!tty) { console.error(PERSON_ONLY(args.setup ? '--setup' : '--on')); process.exit(1); }
      const io = terminal();
      try { const r = await (args.setup ? setupShare : turnOnShare)({ project, nunchiDir, io }); process.exitCode = r.code; } finally { io.close(); }
      return;
    }
    if (args.off) { console.log(offShare({ nunchiDir, deps: { channel: tty ? 'cli-tty' : 'cli-agent' } })); return; }
    if (args.status) { const r = shareStatus({ nunchiDir, project }); if (args.json) console.log(JSON.stringify(r, null, 2)); else for (const l of r.lines) console.log(l); return; }
    const r = share({ project, nunchiDir, root, run: args.run ?? null, version });
    if (args.json) console.log(JSON.stringify(r.json, null, 2));
    else for (const l of r.lines) (r.code ? console.error : console.log)(l);
    process.exitCode = r.code;
  } catch (e) {
    if (LEDGER_ERRORS.includes(e.code) || ['GIT_UNSAFE', 'BAD_ARGS'].includes(e.code)) { console.error(`nunchi share: ${e.message}`); process.exit(2); }
    throw e;
  }
}
