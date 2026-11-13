// Cliente da API do ClickUp + config do dev. O caminho sem prefixo de versão vai pra v2; "/v3/..." passa como está.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseToml } from "./toml.mjs";

export class ErroCli extends Error { constructor(m, code = 1) { super(m); this.name = "ErroCli"; this.code = code; } }
export const die = (m, code = 1) => { throw new ErroCli(m, code); };

export const caminhoConfig = (env = process.env) => env.CLICKUP_CONFIG || path.join(homedir(), ".clickup.toml");

/** token e team_id: env ganha do ~/.clickup.toml, que ganha do ~/.clickup-flow.toml (o token do clickup-flow serve aqui). */
export function lerConfig(env = process.env) {
  const arquivos = env.CLICKUP_CONFIG
    ? [env.CLICKUP_CONFIG]
    : [path.join(homedir(), ".clickup-flow.toml"), path.join(homedir(), ".clickup.toml")];
  let c = {};
  for (const p of arquivos) if (existsSync(p)) c = { ...c, ...parseToml(readFileSync(p, "utf8")) };
  const teamId = env.CLICKUP_TEAM_ID || c.team_id;
  return { token: env.CLICKUP_TOKEN || c.token || null, teamId: teamId ? String(teamId) : null };
}

export class ClickUp {
  constructor(token, base = "https://api.clickup.com/api") { this.token = token; this.base = base.replace(/\/$/, ""); }

  /** query: valor array vira `chave[]=a&chave[]=b`; undefined/null/false ficam de fora. */
  async req(method, ep, { query, body } = {}) {
    const url = new URL(this.base + (/^\/v\d+\//.test(ep) ? ep : "/v2" + ep));
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (Array.isArray(v)) for (const x of v) url.searchParams.append(k + "[]", String(x));
      else url.searchParams.append(k, String(v));
    }
    const rotulo = `${method} ${url.pathname}`;
    let r;
    try {
      r = await fetch(url, {
        method,
        headers: { authorization: this.token, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) { die(`${rotulo}: ${e.cause?.message || e.message}`); }
    const txt = await r.text();
    let json = null;
    try { json = txt ? JSON.parse(txt) : {}; } catch {}
    if (!r.ok) {
      const motivo = json?.err ? `${json.err}${json.ECODE ? ` (${json.ECODE})` : ""}` : txt.slice(0, 300);
      die(`${rotulo}: HTTP ${r.status} ${motivo}`);
    }
    return json ?? txt;
  }
}
