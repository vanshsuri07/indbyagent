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
import { rsvpCommand } from "./commands/rsvp.js";

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
  rsvp: {
    description: "RSVP to an invite",
    run: rsvpCommand,
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
  const rawArgs = process.argv.slice(2);
  const firstPositional = rawArgs.find((arg) => !arg.startsWith("-"));

  if (!firstPositional) {
    printHelp();
    return rawArgs.includes("--help") || rawArgs.includes("-h") ? 0 : 2;
  }

  const cmd = commands[firstPositional];
  if (!cmd) {
    if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
      printHelp();
      return 0;
    }
    console.error(`Unknown command: ${firstPositional}\nRun 'indby-guest --help' for usage.`);
    return 2;
  }

  const cmdIdx = rawArgs.indexOf(firstPositional);
  const cmdArgs = [...rawArgs.slice(0, cmdIdx), ...rawArgs.slice(cmdIdx + 1)];
  return cmd.run(cmdArgs);
}

main().then((code) => process.exit(code));
