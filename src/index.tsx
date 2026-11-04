#!/usr/bin/env node

import { render } from "ink";
import {
  getCatalogEntry,
  makeCatalogProvider,
  needsApiKey,
  providerUsesKey,
  PROVIDER_ORDER
} from "./configs/catalog";
import {
  getConfigPath,
  getCredentialsPath,
  loadConfig,
  loadCredentials,
  maskApiKey,
  resolveApiKey
} from "./configs/config";
import { App } from "./cli/App";
import { createProviderAdapter } from "./providers/registry";
import { errorMessage } from "./cli/utils";
import { VERSION } from "./version";

const useColor = Boolean(process.stdout.isTTY);

function paint(
  code: number,
  text: string
): string {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
}

const bold = (text: string) => paint(1, text);
const dim = (text: string) => paint(2, text);
const cyan = (text: string) => paint(36, text);
const green = (text: string) => paint(32, text);
const red = (text: string) => paint(31, text);
const yellow = (text: string) => paint(33, text);

function printHelp(): void {
  console.log(`
${bold("euler")} ${dim(VERSION)}
${dim("A provider-agnostic coding agent for the terminal. Bring your own API key.")}

${bold("Usage")}
  ${cyan("euler")}                    Launch interactive chat
  ${cyan("euler setup")}              Force provider setup
  ${cyan("euler models [provider]")}  List models for a provider
  ${cyan("euler providers")}          Show providers and connection status
  ${cyan("euler config")}             Show config file locations
  ${cyan("euler --help")}             Show this help
  ${cyan("euler --version")}          Show version

${bold("Interactive commands")}
  /help       Show commands and keyboard shortcuts
  /model      Switch the active model
  /reasoning  Set the reasoning effort for the active model
  /provider   Connect or switch an API provider
  /key        Replace the saved API key
  /new        Start a fresh conversation
  /tools      List agent tools and approval policies
  /undo       Undo the last file write or edit
  /config     Show config paths and connection details
  /quit       Exit

${bold("Agent")}
  Read-only tools (listing, reading, search, git) run automatically.
  File writes, edits, and shell commands show a diff or command and wait
  for y/n approval. Paths are restricted to the workspace, and secret
  files are blocked.

${bold("Keys")}
  Paste a key during setup, or set one of the provider environment
  variables. Stored keys live in ${dim("~/.config/euler/credentials.json")}.
`);
}

async function resolveProvider(
  providerId: string | undefined
) {
  const [config, credentials] = await Promise.all([
    loadConfig(),
    loadCredentials()
  ]);

  const id =
    providerId ??
    config.defaultProvider ??
    Object.keys(config.providers)[0];

  if (!id) {
    return { id: undefined, config, credentials, provider: undefined };
  }

  const provider =
    config.providers[id] ?? makeCatalogProvider(id);

  return { id, config, credentials, provider };
}

async function runModels(providerId?: string): Promise<void> {
  const { id, provider, credentials } = await resolveProvider(
    providerId
  );

  if (!id) {
    console.error(
      `${yellow("No provider is configured.")} Run ${cyan(
        "euler setup"
      )} first.`
    );
    process.exitCode = 1;
    return;
  }

  if (!provider) {
    console.error(
      `${yellow("Unknown provider:")} ${id}. Run ${cyan(
        "euler providers"
      )} to see the catalog.`
    );
    process.exitCode = 1;
    return;
  }

  const apiKey = resolveApiKey(id, provider, credentials);

  if (needsApiKey(provider) && !apiKey) {
    console.error(
      `${yellow("No API key for")} ${bold(provider.name)}. Run ${cyan(
        "euler setup"
      )} or set ${cyan(provider.apiKeyEnv ?? "the provider key")}.`
    );
    process.exitCode = 1;
    return;
  }

  try {
    const adapter = createProviderAdapter(
      id,
      provider,
      apiKey
    );
    const models = await adapter.listModels();

    const keyLabel = providerUsesKey(provider)
      ? `key ${maskApiKey(apiKey)}`
      : "no key needed";

    console.log(
      `${bold(provider.name)} ${dim(
        `· ${models.length} models · ${keyLabel}`
      )}`
    );

    for (const model of models) {
      const details = [
        model.contextWindow
          ? `${Math.round(model.contextWindow / 1000)}k ctx`
          : "",
        model.description ?? ""
      ]
        .filter(Boolean)
        .join(" · ");

      console.log(
        `  ${model.id}${
          details ? `  ${dim(details)}` : ""
        }`
      );
    }
  } catch (error) {
    console.error(red(errorMessage(error)));
    process.exitCode = 1;
  }
}

async function runProviders(): Promise<void> {
  const [config, credentials] = await Promise.all([
    loadConfig(),
    loadCredentials()
  ]);

  const ids = [
    ...PROVIDER_ORDER,
    ...Object.keys(config.providers).filter(
      (providerId) => !PROVIDER_ORDER.includes(providerId)
    )
  ];

  console.log(bold("Providers"));
  console.log(
    dim(
      "  id              name                 status"
    )
  );

  for (const id of ids) {
    const provider =
      config.providers[id] ?? makeCatalogProvider(id);

    if (!provider) {
      continue;
    }

    const configured = Boolean(config.providers[id]);
    const apiKey = resolveApiKey(id, provider, credentials);
    const keyStatus = !providerUsesKey(provider)
      ? dim("no key")
      : apiKey
        ? green("key")
        : needsApiKey(provider)
          ? yellow("needs key")
          : dim("optional key");

    const status = configured
      ? green("configured")
      : dim("available");

    console.log(
      `  ${id.padEnd(15)} ${provider.name.padEnd(20)} ${status}  ${keyStatus}`
    );
  }

  const customIds = Object.keys(config.providers).filter(
    (id) => !getCatalogEntry(id)
  );

  if (customIds.length > 0) {
    console.log(dim(`\n  Custom IDs: ${customIds.join(", ")}`));
  }

  console.log(
    dim(`\n  Config: ${getConfigPath()}`)
  );
}

async function runConfig(): Promise<void> {
  const [config, credentials] = await Promise.all([
    loadConfig(),
    loadCredentials()
  ]);

  console.log(bold("Configuration"));
  console.log(`  config       ${getConfigPath()}`);
  console.log(`  credentials  ${getCredentialsPath()}`);
  console.log(
    `  provider     ${config.defaultProvider ?? dim("not set")}`
  );
  console.log(
    `  model        ${config.defaultModel ?? dim("not set")}`
  );

  const ids = Object.keys(config.providers);

  if (ids.length === 0) {
    console.log(dim("\n  No providers configured."));
    return;
  }

  console.log(bold("\nProviders"));

  for (const id of ids) {
    const provider = config.providers[id];

    if (!provider) {
      continue;
    }

    const key = resolveApiKey(id, provider, credentials);
    const source = credentials[id]
      ? "stored"
      : key
        ? "environment"
        : "none";

    console.log(
      `  ${id}  ${provider.name}  ${provider.baseUrl}`
    );
    console.log(
      dim(
        `    model ${provider.defaultModel ?? "not set"} · key ${source} ${maskApiKey(
          key
        )}`
      )
    );
  }
}

function printNoTty(): void {
  console.error(
    [
      "euler needs an interactive terminal for chat.",
      "",
      "Non-interactive commands:",
      "  euler models [provider]",
      "  euler providers",
      "  euler config",
      "  euler --help"
    ].join("\n")
  );
  process.exitCode = 1;
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];

  if (
    command === "--help" ||
    command === "-h" ||
    command === "help"
  ) {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }

  if (command === "models") {
    void runModels(args[1]);
    return;
  }

  if (command === "providers") {
    void runProviders();
    return;
  }

  if (command === "config") {
    void runConfig();
    return;
  }

  if (command === "setup") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      printNoTty();
      return;
    }

    render(<App forceSetup />, {
      exitOnCtrlC: false
    });
    return;
  }

  if (command && command !== "chat") {
    console.error(red(`Unknown command: ${command}`));
    console.error(dim("Run euler --help for usage."));
    process.exitCode = 1;
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printNoTty();
    return;
  }

  render(<App />, {
    exitOnCtrlC: false
  });
}

main();
