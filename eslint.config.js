import tseslint from "typescript-eslint";

const restrict = (names) => ({
  "no-restricted-imports": [
    "error",
    {
      patterns: names.flatMap((n) => [
        { group: [`@agentcity/${n}`, `@agentcity/${n}/*`], message: `Import direction: this package must not import ${n}.` },
        { group: [`../../${n}/*`, `../../../${n}/*`, `../../../../${n}/*`], message: `Import direction: this package must not import ${n}.` },
      ]),
    },
  ],
});

export default tseslint.config(
  { ignores: ["**/dist/**", "packages/client/dist/**", "**/node_modules/**", "**/*.tsbuildinfo"] },
  ...tseslint.configs.recommended,
  { files: ["packages/core/**/*.ts"], rules: restrict(["safety", "org", "cli"]) },
  { files: ["packages/safety/**/*.ts"], rules: restrict(["org", "cli"]) },
  // org builds board tools on the safety board store; safety never imports org, so no cycle forms.
  { files: ["packages/org/**/*.ts"], rules: restrict(["cli"]) },
  { files: ["packages/world/**/*.ts"], rules: restrict(["org", "cli"]) },
  {
    files: ["packages/client/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "@agentcity/world", message: "Import direction: client imports only @agentcity/world/shared." }],
          patterns: [
            ...restrict(["core", "safety", "org", "cli"])["no-restricted-imports"][1].patterns,
            {
              group: ["@agentcity/world/*", "!@agentcity/world/shared"],
              message: "Import direction: client imports only @agentcity/world/shared.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/world/src/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["@agentcity/*", "node:*"], message: "shared must be Node-free and import only zod." }] },
      ],
    },
  },
);
