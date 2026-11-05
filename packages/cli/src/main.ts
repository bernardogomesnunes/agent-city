#!/usr/bin/env node
import { runCli } from "./wire.js";

process.exitCode = await runCli(process.argv.slice(2));
