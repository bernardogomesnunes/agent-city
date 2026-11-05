import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { restrictToOwner } from "./secrets.js";

/** Sign-in state for one MCP server: the registered client, tokens and the PKCE verifier. Owner-only file. */
export const mcpAuthFile = (home: string, server: string): string => path.join(home, "mcp-auth", `${server}.json`);

interface Saved { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string; redirectUrl?: string }

/**
 * OAuth for an MCP HTTP server, stored under `<home>/mcp-auth`. The server's own sign-in page does the login;
 * no password or key passes through Agent City. `onRedirect` gets the sign-in address. Without it (inside a run),
 * a server that needs a new sign-in fails with a message pointing to HQ.
 */
export class FileAuthProvider implements OAuthClientProvider {
  readonly stateValue = randomBytes(16).toString("hex");

  constructor(
    private readonly home: string,
    private readonly server: string,
    private readonly redirect: string | undefined,
    private readonly onRedirect?: (url: URL) => void,
  ) {}

  private read(): Saved {
    try {
      return JSON.parse(fs.readFileSync(mcpAuthFile(this.home, this.server), "utf8")) as Saved;
    } catch {
      return {};
    }
  }

  private write(patch: Partial<Saved>): void {
    const file = mcpAuthFile(this.home, this.server);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fresh = !fs.existsSync(file);
    fs.writeFileSync(file, JSON.stringify({ ...this.read(), ...patch }, null, 2));
    if (fresh) restrictToOwner(file);
  }

  get redirectUrl(): string | undefined {
    // A run reuses the address the sign-in registered, so token refresh matches the registered client.
    return this.redirect ?? this.read().redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Agent City",
      redirect_uris: this.redirectUrl ? [this.redirectUrl] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.stateValue;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const s = this.read();
    // A client registered for another callback address cannot finish a sign-in here.
    if (this.redirect !== undefined && s.redirectUrl !== this.redirect) return undefined;
    return s.client;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.write({ client, redirectUrl: this.redirectUrl });
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.write({ tokens });
  }

  redirectToAuthorization(url: URL): void {
    if (!this.onRedirect) throw new Error(`MCP server ${this.server} needs a sign-in. Open HQ, MCP tab, and press Sign in.`);
    this.onRedirect(url);
  }

  saveCodeVerifier(verifier: string): void {
    this.write({ verifier });
  }

  codeVerifier(): string {
    const v = this.read().verifier;
    if (!v) throw new Error("no sign-in in progress");
    return v;
  }
}
