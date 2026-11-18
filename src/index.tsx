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
import { ProviderAuthService } from "./providers/auth-service";
import {
  fetchAllModels,
  fetchModelsForProvider
} from "./providers/model-service";
import { errorMessage } from "./cli/utils";
import { ProviderConfig } from "./interfaces/type";
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
  ${cyan("euler models --all")}       List models from every configured provider
  ${cyan("euler providers")}          Show providers and connection status
  ${cyan("euler login <provider>")}   Validate and save a key (read from stdin)
  ${cyan("euler logout <provider>")}  Delete a provider's saved API key
  ${cyan("euler validate [provider]")} Check the current key with the provider
  ${cyan("euler config")}             Show config file locations
  ${cyan("euler --help")}             Show this help
  ${cyan("euler --version")}          Show version

${bold("Interactive commands")}
  /help       Show commands and keyboard shortcuts
  /model      Switch the active model
  /reasoning  Set the reasoning effort for the active model
  /provider   Connect or switch an API provider
  /login      Log in to a provider and store its API key
  /logout     Log out and delete a provider's saved key
  /validate   Check the active provider's API key
  /key        Replace the saved API key
  /new        Start a fresh conversation (keeps the old session)
  /sessions   Browse and resume saved sessions
  /rename     Rename the current session
  /fork       Fork the current session
  /delete     Delete a saved session
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
  /login stores a key after validating it; /logout removes the stored key.
  To invalidate a key with the provider itself, use its console.
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

function modelLine(model: {
  id: string;
  contextWindow?: number;
  description?: string;
  variants?: { name: string }[];
}): string {
  const details = [
    model.contextWindow
      ? `${Math.round(model.contextWindow / 1000)}k ctx`
      : "",
    model.description ?? ""
  ]
    .filter(Boolean)
    .join(" · ");

  const variants = model.variants?.length
    ? dim(
        `[${model.variants.map((variant) => variant.name).join(", ")}]`
      )
    : "";

  return `  ${model.id}${details ? `  ${dim(details)}` : ""}${
    variants ? `  ${variants}` : ""
  }`;
}

async function runModels(providerArg?: string): Promise<void> {
  if (providerArg === "--all" || providerArg === "all") {
    const [config, credentials] = await Promise.all([
      loadConfig(),
      loadCredentials()
    ]);
    const result = await fetchAllModels(config, credentials);

    for (const provider of result.providers) {
      console.log(
        `${bold(provider.name)} ${dim(`· ${provider.id}`)}`
      );

      if (provider.error) {
        console.log(red(`  ${provider.error}`));
        console.log("");
        continue;
      }

      console.log(dim(`  ${provider.models.length} models`));

      for (const model of provider.models) {
        console.log(modelLine(model));
      }

      console.log("");
    }

    if (result.providers.length === 0) {
      console.error(
        yellow("No configured providers with usable keys.")
      );
      process.exitCode = 1;
    }

    return;
  }

  const { id, provider, credentials } = await resolveProvider(
    providerArg
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
    const models = await fetchModelsForProvider(
      id,
      provider,
      apiKey
    );

    const keyLabel = providerUsesKey(provider)
      ? `key ${maskApiKey(apiKey)}`
      : "no key needed";

    console.log(
      `${bold(provider.name)} ${dim(
        `· ${models.length} models · ${keyLabel}`
      )}`
    );

    for (const model of models) {
      console.log(modelLine(model));
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

async function readKeyFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    );
  }

  return Buffer.concat(chunks).toString("utf-8").trim();
}

async function requireProvider(
  providerArg: string | undefined
): Promise<{
  id?: string;
  provider?: ProviderConfig;
}> {
  const { id, provider } = await resolveProvider(providerArg);

  if (!id) {
    console.error(
      `${yellow("No provider is configured.")} Run ${cyan(
        "euler setup"
      )} first.`
    );
    process.exitCode = 1;
    return {};
  }

  if (!provider) {
    console.error(`${yellow("Unknown provider:")} ${id}.`);
    process.exitCode = 1;
    return {};
  }

  return { id, provider };
}

async function runLogin(providerArg?: string): Promise<void> {
  if (process.stdin.isTTY) {
    console.error(
      "Pipe a key from stdin, for example:\n" +
        `  ${cyan("echo 'sk-…' | euler login openai")}\n` +
        `Or run ${cyan("euler setup")} / ${cyan(
          "/login"
        )} for the interactive flow.`
    );
    process.exitCode = 1;
    return;
  }

  const apiKey = await readKeyFromStdin();

  if (!apiKey) {
    console.error(yellow("No API key received on stdin."));
    process.exitCode = 1;
    return;
  }

  const { id, provider } = await requireProvider(providerArg);

  if (!id || !provider) {
    return;
  }

  try {
    const result = await new ProviderAuthService().login({
      providerId: id,
      provider,
      apiKey
    });

    const verification = result.validated
      ? "verified"
      : "saved without verification";

    console.log(
      green(`Logged in to ${provider.name}.`) +
        dim(` key ${maskApiKey(apiKey)} · ${verification}`)
    );

    if (provider.keyUrl) {
      console.log(
        dim(`  Revoke this key at ${provider.keyUrl}`)
      );
    }
  } catch (error) {
    console.error(red(errorMessage(error)));
    process.exitCode = 1;
  }
}

async function runLogout(providerArg?: string): Promise<void> {
  const { id, provider } = await requireProvider(providerArg);

  if (!id || !provider) {
    return;
  }

  const result = await new ProviderAuthService().logout({
    providerId: id,
    provider
  });

  if (!result.removed) {
    console.log(
      yellow(`No saved key for ${provider.name} to remove.`)
    );
    return;
  }

  console.log(
    green(
      `Logged out of ${provider.name}. Saved API key deleted.`
    )
  );

  if (result.environmentFallback) {
    console.log(
      yellow(
        `An environment key (${
          provider.apiKeyEnv ?? "env"
        }) is still in use. Unset it to fully disconnect.`
      )
    );
  }

  if (provider.keyUrl) {
    console.log(
      dim(
        `  This removes the local copy only; revoke at ${provider.keyUrl} to invalidate it remotely.`
      )
    );
  }
}

async function runValidate(providerArg?: string): Promise<void> {
  const { id, provider } = await requireProvider(providerArg);

  if (!id || !provider) {
    return;
  }

  const credentials = await loadCredentials();
  const apiKey = resolveApiKey(id, provider, credentials);
  const result = await new ProviderAuthService().validate(
    id,
    provider,
    apiKey
  );

  if (result.valid) {
    console.log(
      green(`✓ ${provider.name} accepted the current key.`)
    );
    return;
  }

  console.error(
    red(
      `✗ ${provider.name} key is not valid: ${
        result.error ?? "unknown error"
      }`
    )
  );
  process.exitCode = 1;
}

function printNoTty(): void {
  console.error(
    [
      "euler needs an interactive terminal for chat.",
      "",
      "Non-interactive commands:",
      "  euler models [provider]",
      "  euler providers",
      "  euler login <provider>   (key from stdin)",
      "  euler logout <provider>",
      "  euler validate [provider]",
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

  if (command === "login") {
    void runLogin(args[1]);
    return;
  }

  if (command === "logout") {
    void runLogout(args[1]);
    return;
  }

  if (command === "validate") {
    void runValidate(args[1]);
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
