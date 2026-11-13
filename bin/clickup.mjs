#!/usr/bin/env node
import { main } from "../src/cli.mjs";
import { ErroCli } from "../src/api.mjs";

main(process.argv.slice(2)).catch((e) => {
  if (e instanceof ErroCli) { console.error("erro: " + e.message); process.exit(e.code); }
  throw e;
});
