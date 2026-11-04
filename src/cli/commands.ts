export interface CommandDefinition {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
}

export const COMMANDS: CommandDefinition[] = [
  {
    name: "help",
    description: "Show commands and keyboard shortcuts"
  },
  {
    name: "model",
    description: "Switch the active model",
    usage: "/model [model-id]"
  },
  {
    name: "models",
    description: "Browse models from the current provider"
  },
  {
    name: "provider",
    description: "Connect or switch an API provider"
  },
  {
    name: "key",
    description: "Replace the API key for this provider"
  },
  {
    name: "new",
    description: "Start a fresh conversation"
  },
  {
    name: "clear",
    description: "Reset the conversation (alias of /new)"
  },
  {
    name: "config",
    description: "Show config paths and connection details"
  },
  {
    name: "status",
    description: "Show the current session status"
  },
  {
    name: "tools",
    description: "List agent tools and approval policies"
  },
  {
    name: "undo",
    description: "Undo the last file write or edit"
  },
  {
    name: "about",
    description: "About this CLI"
  },
  {
    name: "quit",
    aliases: ["exit", "q"],
    description: "Exit the CLI"
  }
];

export function findCommand(
  name: string
): CommandDefinition | undefined {
  const normalized = name.toLowerCase();

  return COMMANDS.find(
    (command) =>
      command.name === normalized ||
      command.aliases?.includes(normalized)
  );
}

export function suggestCommands(input: string): CommandDefinition[] {
  if (!input.startsWith("/") || input.includes(" ")) {
    return [];
  }

  const query = input.slice(1).toLowerCase();

  return COMMANDS.filter(
    (command) =>
      command.name.startsWith(query) ||
      command.aliases?.some((alias) => alias.startsWith(query))
  );
}
