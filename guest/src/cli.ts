#!/usr/bin/env node
/**
 * indby-guest CLI — a reference guest agent for IndbyAgent.
 *
 * Usage:
 *   indby-guest read  <invite-url>  [--json]   Read an invite
 *   indby-guest --help                          Show help
 *
 * Exit codes:
 *   0 — success
 *   1 — runtime / server error
 *   2 — usage error (bad arguments, unknown command)
 */
import { parseArgs } from "node:util";
import { readCommand } from "./commands/read.js";

// ---------- command registry ----------

interface Command {
  description: string;
  run: (args: string[]) => Promise<number>;
}

const commands: Record<string, Command> = {
  read: {
    description: "Fetch and display an invite",
    run: readCommand,
  },
};

// ---------- help ----------

function printHelp(): void {
  console.log(`indby-guest — reference guest agent CLI for IndbyAgent

Usage:
  indby-guest <command> [options]

Commands:`);
  for (const [name, cmd] of Object.entries(commands)) {
    console.log(`  ${name.padEnd(12)} ${cmd.description}`);
  }
  console.log(`
Global options:
  --help       Show this help message

Exit codes:
  0  success
  1  runtime / server error
  2  usage error`);
}

// ---------- main ----------

async function main(): Promise<number> {
  // Parse only the global --help flag; leave the rest to subcommands.
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || positionals.length === 0) {
    printHelp();
    return positionals.length === 0 && !values.help ? 2 : 0;
  }

  const cmdName = positionals[0];
  const cmd = commands[cmdName];
  if (!cmd) {
    console.error(`Unknown command: ${cmdName}\nRun 'indby-guest --help' for usage.`);
    return 2;
  }

  return cmd.run(positionals.slice(1));
}

main().then((code) => process.exit(code));
