/**
 * Seed data for the implied consent pattern store.
 *
 * Each entry maps a canonical request phrase to the EffectClass array it
 * implies. On first database creation the store is populated with these
 * patterns and their embeddings. The seed set is intentionally conservative
 * -- the binder subtracts prohibitions downstream, so over-granting here
 * is caught later.
 */

import type { EffectClass } from "./types.js";

export type ConsentSeedEntry = {
  text: string;
  effects: readonly EffectClass[];
};

/**
 * Curated canonical patterns organized by primary effect category.
 * Compound patterns (multiple effect classes) appear in each relevant
 * section where their primary intent lies.
 */
export const CONSENT_SEED_PATTERNS: readonly ConsentSeedEntry[] = [
  // --- Read-only / informational queries ---
  { text: "What is this file about?", effects: ["read", "compose"] },
  { text: "Tell me about the project structure", effects: ["read", "compose"] },
  { text: "How does this function work?", effects: ["read", "compose"] },
  { text: "Explain the error in this code", effects: ["read", "compose"] },
  { text: "Summarize this document", effects: ["read", "compose"] },
  { text: "What are the dependencies in this project?", effects: ["read", "compose"] },
  { text: "List all the files in this directory", effects: ["read", "compose"] },
  { text: "Find all TODO comments in the codebase", effects: ["read", "compose"] },
  { text: "Show me the contents of the configuration file", effects: ["read", "compose"] },
  { text: "What tests are failing?", effects: ["read", "compose"] },
  { text: "Compare these two files", effects: ["read", "compose"] },
  { text: "What does this variable do?", effects: ["read", "compose"] },
  { text: "Search for the function definition", effects: ["read", "compose"] },
  { text: "Read the README and summarize it", effects: ["read", "compose"] },
  { text: "What version of Node is this project using?", effects: ["read", "compose"] },

  // --- File writing / editing ---
  { text: "Write a new file called utils.ts", effects: ["read", "compose", "persist"] },
  { text: "Create a script that processes CSV data", effects: ["read", "compose", "persist"] },
  {
    text: "Edit the configuration file to add a new entry",
    effects: ["read", "compose", "persist"],
  },
  {
    text: "Update the README with installation instructions",
    effects: ["read", "compose", "persist"],
  },
  {
    text: "Fix the bug in this function and save the file",
    effects: ["read", "compose", "persist"],
  },
  { text: "Refactor this class into smaller modules", effects: ["read", "compose", "persist"] },
  { text: "Add error handling to this function", effects: ["read", "compose", "persist"] },
  { text: "Create a new test file for the utils module", effects: ["read", "compose", "persist"] },
  { text: "Rename the variable across all files", effects: ["read", "compose", "persist"] },
  { text: "Add TypeScript types to this JavaScript file", effects: ["read", "compose", "persist"] },
  { text: "Generate a .gitignore file", effects: ["compose", "persist"] },
  { text: "Save this output to a log file", effects: ["compose", "persist"] },

  // --- Communication / disclosure ---
  { text: "Send a message to the team channel", effects: ["disclose"] },
  { text: "Email the report to the manager", effects: ["disclose"] },
  { text: "Notify the user about the status update", effects: ["disclose"] },
  { text: "Post this summary to Slack", effects: ["disclose"] },
  { text: "Reply to the message in the group chat", effects: ["disclose"] },
  { text: "Forward this information to the admin", effects: ["disclose"] },
  { text: "Share the build results with the team", effects: ["disclose"] },
  { text: "Send a notification about the deployment", effects: ["disclose"] },

  // --- Shell execution ---
  { text: "Run this command in the terminal", effects: ["exec"] },
  { text: "Execute the test suite", effects: ["exec"] },
  { text: "Install the dependencies with npm", effects: ["exec"] },
  { text: "Build the project", effects: ["exec"] },
  { text: "Start the development server", effects: ["exec"] },
  { text: "Run the linter on the codebase", effects: ["exec"] },
  { text: "Compile the TypeScript files", effects: ["exec"] },
  { text: "Run the migration scripts", effects: ["exec"] },
  { text: "Execute a database query", effects: ["exec"] },
  { text: "Restart the service", effects: ["exec"] },

  // --- Deletion / irreversible ---
  { text: "Delete the temporary files", effects: ["irreversible", "persist"] },
  { text: "Remove the old log directory", effects: ["irreversible", "persist"] },
  { text: "Clean up the build artifacts", effects: ["irreversible", "persist"] },
  { text: "Drop the test database", effects: ["irreversible", "exec"] },
  { text: "Permanently remove the user account", effects: ["irreversible"] },
  { text: "Wipe the cache and rebuild", effects: ["irreversible", "exec"] },
  { text: "Purge all expired sessions", effects: ["irreversible"] },
  { text: "Delete this branch from the remote", effects: ["irreversible", "exec"] },

  // --- Network / outbound ---
  { text: "Search the web for the latest documentation", effects: ["network", "read"] },
  { text: "Fetch the page at this URL", effects: ["network", "read"] },
  { text: "Download the file from the CDN", effects: ["network", "read"] },
  { text: "Check if the API endpoint is responding", effects: ["network", "read"] },
  { text: "Look up the npm package details", effects: ["network", "read"] },
  { text: "Pull the latest data from the remote service", effects: ["network", "read"] },
  { text: "Query the external API for user information", effects: ["network", "read"] },
  { text: "Verify the SSL certificate for this domain", effects: ["network", "read"] },

  // --- Elevated / administrative ---
  { text: "Set up a cron job to run daily backups", effects: ["elevated", "persist"] },
  { text: "Configure the gateway settings", effects: ["elevated"] },
  { text: "Create a new agent with custom permissions", effects: ["elevated", "persist"] },
  { text: "Update the system configuration", effects: ["elevated", "persist"] },
  { text: "Register a new webhook endpoint", effects: ["elevated", "network"] },
  { text: "Manage the node connections", effects: ["elevated"] },

  // --- Audience-expand ---
  { text: "Add this user to the group chat", effects: ["audience-expand", "disclose"] },
  { text: "Broadcast the announcement to all channels", effects: ["audience-expand", "disclose"] },
  { text: "Invite new members to the workspace", effects: ["audience-expand"] },
  { text: "Make this document publicly accessible", effects: ["audience-expand", "disclose"] },

  // --- Compound / multi-effect ---
  { text: "Write a script and run it", effects: ["read", "compose", "persist", "exec"] },
  { text: "Download the CSV and save it locally", effects: ["network", "read", "persist"] },
  {
    text: "Fetch the API data and write it to a file",
    effects: ["network", "read", "compose", "persist"],
  },
  {
    text: "Read the config, update the settings, and restart the service",
    effects: ["read", "compose", "persist", "exec"],
  },
  {
    text: "Build the project and deploy to production",
    effects: ["exec", "network", "irreversible"],
  },
  { text: "Generate a report and email it to the team", effects: ["read", "compose", "disclose"] },
  {
    text: "Search online for a solution and apply the fix",
    effects: ["network", "read", "compose", "persist"],
  },
  {
    text: "Delete the old files and create fresh backups",
    effects: ["irreversible", "persist", "read"],
  },
  { text: "Run the tests and post results to the channel", effects: ["exec", "disclose"] },
  {
    text: "Create a new API endpoint and register it with the gateway",
    effects: ["compose", "persist", "elevated"],
  },
];
