// Stand-in for the `claude` binary in ClaudeCliProvider tests.
// Logs what it got to FAKE_CLAUDE_LOG, then answers per FAKE_CLAUDE_MODE.
import fs from "node:fs";

const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  const argv = process.argv.slice(2);
  const sysAt = argv.indexOf("--system-prompt-file");
  fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
    argv,
    cwd: process.cwd(),
    cwdFiles: fs.readdirSync(process.cwd()),
    system: sysAt >= 0 ? fs.readFileSync(argv[sysAt + 1], "utf8") : null,
    hasApiKey: "ANTHROPIC_API_KEY" in process.env,
    hasAuthToken: "ANTHROPIC_AUTH_TOKEN" in process.env,
    stdin: Buffer.concat(chunks).toString("utf8"),
    pid: process.pid,
  }));
  const result = (text, isError = false) =>
    process.stdout.write(JSON.stringify({
      type: "result", is_error: isError, result: text,
      usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 1, output_tokens: 7 },
    }));
  switch (process.env.FAKE_CLAUDE_MODE) {
    case "tool":
      result('<tool_call>{"name":"write_file","arguments":{"path":"a.txt","content":"hi"}}</tool_call>');
      break;
    case "text": result("done"); break;
    case "empty": result(""); break;
    case "error": result("Invalid API key · Please run /login", true); process.exitCode = 1; break;
    case "exit": process.stderr.write("boom"); process.exitCode = 2; break;
    case "hang": setInterval(() => {}, 1000); break;
    default: result("unknown mode");
  }
});
