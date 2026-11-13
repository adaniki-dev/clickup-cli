// clickup — CLI do ClickUp (API v2). `clickup <recurso> <ação> [args] [--flags]`.
// Saída em texto enxuto por padrão; --json devolve a resposta crua da API.
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { ClickUp, die, lerConfig, caminhoConfig } from "./api.mjs";

export const VERSAO = "0.1.0";
const PRIORIDADE = { urgent: 1, high: 2, normal: 3, low: 4 };
const TIPOS_KR = ["number", "currency", "boolean", "percentage", "automatic"];

// ---------------------------------------------------------------- argv

const BOOL = new Set(["json", "yes", "closed", "subtasks", "completed", "resolved", "notify", "archive", "help", "version"]);
const GLOBAIS = ["json", "team", "help", "version"];

class Flags {
  constructor(m) { this.m = m; }
  tem(k) { return k in this.m; }
  um(k) { return this.m[k]?.at(-1); }
  varios(k) { return this.m[k] || []; }
}

/** `--k v`, `--k=v`, booleanas sem valor; flag repetida acumula. `--` encerra as flags. */
export function parseArgv(argv) {
  const m = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("--")) { pos.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s);
    if (BOOL.has(k)) v = true;
    else if (v === undefined) {
      if (i + 1 >= argv.length) die(`--${k} precisa de valor`);
      v = argv[++i];
    }
    (m[k] ??= []).push(v);
  }
  return { pos, flags: new Flags(m) };
}

// ---------------------------------------------------------------- conversões

/** Data -> ms. `2026-11-20` é o dia (sem hora), `2026-11-20T15:00` tem hora, número com 11+ dígitos já é ms. */
export function parseData(v) {
  if (/^\d{11,}$/.test(v)) return { ms: Number(v), hora: true };
  const d = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (d) return { ms: new Date(+d[1], +d[2] - 1, +d[3]).getTime(), hora: false };
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) die(`data inválida: ${v} (use AAAA-MM-DD, AAAA-MM-DDTHH:MM ou ms)`);
  return { ms, hora: true };
}

function prioridade(v) {
  if (v === "none") return null;
  const p = PRIORIDADE[v] ?? (/^[1-4]$/.test(v) ? Number(v) : undefined);
  if (p === undefined) die(`prioridade inválida: ${v} (urgent|high|normal|low|none)`);
  return p;
}

const num = (v, nome) => { const n = Number(v); if (v === "" || Number.isNaN(n)) die(`--${nome} precisa ser número: ${v}`); return n; };
/** Texto longo: `-` lê do stdin, `@arquivo` lê do arquivo. */
const texto = (v) => (v === "-" ? readFileSync(0, "utf8") : v?.startsWith("@") ? readFileSync(v.slice(1), "utf8") : v);
const jsonOuTexto = (v) => { try { return JSON.parse(v); } catch { return v; } };
/** Tira chave undefined e array vazio: a API não precisa receber o que o dev não pediu. */
const limpo = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)));

// ---------------------------------------------------------------- formatação

const dia = (ms) => (ms ? new Date(Number(ms)).toLocaleDateString("sv-SE") : "");
const nomes = (us) => (us || []).map((u) => u.username || u.email || u.id).join(", ");
const pct = (v) => (v === null || v === undefined ? "" : `${Math.round(Number(v) * 100) / 100}`);
const junta = (...xs) => xs.filter(Boolean).join("  ");

const linhaTask = (t) =>
  junta(t.id, `[${t.status?.status ?? "?"}]`, t.name, nomes(t.assignees) && `@${nomes(t.assignees)}`, t.due_date && `vence ${dia(t.due_date)}`);

function detalheTask(t) {
  const l = [
    `${t.id}  ${t.name}`,
    `  status: ${t.status?.status ?? "?"} | prioridade: ${t.priority?.priority ?? "-"} | responsáveis: ${nomes(t.assignees) || "-"}`,
    `  lista: ${t.list?.name ?? "?"} (${t.list?.id ?? "?"})${t.parent ? ` | pai: ${t.parent}` : ""}${t.points != null ? ` | pontos: ${t.points}` : ""}`,
  ];
  if (t.start_date || t.due_date) l.push(`  início: ${dia(t.start_date) || "-"} | vence: ${dia(t.due_date) || "-"}`);
  if (t.tags?.length) l.push(`  tags: ${t.tags.map((x) => x.name).join(", ")}`);
  for (const d of t.dependencies || [])
    l.push(d.task_id === t.id ? `  depende de: ${d.depends_on}` : `  bloqueia: ${d.task_id}`);
  for (const k of t.linked_tasks || []) l.push(`  link: ${k.task_id === t.id ? k.link_id : k.task_id}`);
  for (const c of (t.custom_fields || []).filter((c) => c.value !== undefined && c.value !== null))
    l.push(`  campo ${c.name} (${c.id}): ${typeof c.value === "string" ? c.value : JSON.stringify(c.value)}`);
  for (const s of t.subtasks || []) l.push(`  sub: ${linhaTask(s)}`);
  l.push(`  ${t.url}`);
  const desc = (t.markdown_description ?? t.description ?? "").trim();
  if (desc) l.push("", desc);
  return l.join("\n");
}

const linhaGoal = (g) =>
  junta(g.id, g.name, `progresso=${pct(g.percent_completed)}`, g.due_date && `vence ${dia(g.due_date)}`,
        g.key_result_count !== undefined && `kr=${g.key_result_count}`);

function linhaKr(k) {
  const atual = k.last_action?.steps_current ?? k.steps_current;
  const passos = k.steps_end !== undefined && k.steps_end !== null ? `${atual ?? k.steps_start ?? 0}/${k.steps_end}${k.unit ? " " + k.unit : ""}` : "";
  return junta(k.id, `[${k.type}]`, k.name, passos, `progresso=${pct(k.percent_completed)}`,
               k.task_ids?.length && `tasks: ${k.task_ids.join(",")}`, k.subcategory_ids?.length && `listas: ${k.subcategory_ids.join(",")}`);
}

function detalheGoal(g) {
  const l = [
    `${g.id}  ${g.name}`,
    `  progresso=${pct(g.percent_completed)} | vence: ${dia(g.due_date) || "-"} | donos: ${nomes(g.owners) || "-"}`,
  ];
  if (g.pretty_url) l.push(`  ${g.pretty_url}`);
  if (g.description?.trim()) l.push(`  ${g.description.trim()}`);
  for (const k of g.key_results || []) l.push(`  kr: ${linhaKr(k)}`);
  return l.join("\n");
}

// ---------------------------------------------------------------- contexto de um comando

function contexto(cu, f, cfg) {
  let eu, times;
  const c = {
    cu, f,
    eu: async () => (eu ??= (await cu.req("GET", "/user")).user),
    times: async () => (times ??= (await cu.req("GET", "/team")).teams || []),
    /** Workspace: --team > CLICKUP_TEAM_ID > team_id do toml > o único que o token enxerga. */
    team: async () => {
      const dado = f.um("team") || cfg.teamId;
      if (dado) return String(dado);
      const ts = await c.times();
      if (ts.length === 1) return String(ts[0].id);
      die(`o token enxerga ${ts.length} workspaces (${ts.map((t) => `${t.id} ${t.name}`).join(", ")}) — passa --team ID ou grava team_id em ${caminhoConfig()}`);
    },
    membros: async () => {
      const id = await c.team();
      return ((await c.times()).find((t) => String(t.id) === id)?.members || []).map((m) => m.user);
    },
    /** id numérico, `me`, ou pedaço do username/email (tem que bater em exatamente um membro). */
    usuario: async (v) => {
      if (/^\d+$/.test(v)) return Number(v);
      if (v === "me") return (await c.eu()).id;
      const alvo = v.toLowerCase();
      const hits = (await c.membros()).filter((u) => `${u.username} ${u.email}`.toLowerCase().includes(alvo));
      if (hits.length !== 1) die(`"${v}" bate em ${hits.length} membros${hits.length ? ` (${hits.map((u) => u.username).join(", ")})` : ""} — usa o id (clickup member ls)`);
      return hits[0].id;
    },
    usuarios: (k) => Promise.all(f.varios(k).map(c.usuario)),
  };
  return c;
}

/** Campos de data da task a partir de --due/--start. */
function datas(f) {
  const o = {};
  for (const [flag, campo] of [["due", "due_date"], ["start", "start_date"]]) {
    if (!f.tem(flag)) continue;
    const { ms, hora } = parseData(f.um(flag));
    o[campo] = ms; o[campo + "_time"] = hora;
  }
  return o;
}

const confirmado = (f, oQue) => { if (!f.tem("yes")) die(`${oQue} é irreversível — repete com --yes`); };

// ---------------------------------------------------------------- comandos
// Cada um: uso (linha da ajuda), args (mínimo de posicionais), flags aceitas, run -> { d: resposta crua, t: texto }.

const FILTROS = ["status", "assignee", "tag", "closed", "subtasks", "page", "name"];

async function listarTasks(c, ep, extra = {}) {
  const { cu, f } = c;
  const query = { ...extra, include_closed: f.tem("closed"), subtasks: f.tem("subtasks"),
                  statuses: f.varios("status"), assignees: await c.usuarios("assignee"), tags: f.varios("tag") };
  const alvo = f.um("name")?.toLowerCase();
  const tasks = [];
  let page = f.tem("page") ? num(f.um("page"), "page") : 0, mais = false;
  // --name filtra no cliente (a v2 não busca por texto), então varre as páginas; sem ele vem uma página só
  for (let voltas = 0; voltas < 30; voltas++) {
    const r = await cu.req("GET", ep, { query: { ...query, page } });
    tasks.push(...(r.tasks || []));
    mais = r.last_page === false;
    if (!alvo || !mais) break;
    page++;
  }
  const d = alvo ? tasks.filter((t) => t.name.toLowerCase().includes(alvo)) : tasks;
  const rodape = mais ? (alvo ? "\n(parei em 30 páginas; pode haver mais)" : `\n(há mais: --page ${page + 1})`) : "";
  return { d, t: (d.map(linhaTask).join("\n") || "nenhuma task") + rodape };
}

const CMD = {
  whoami: {
    uso: "whoami", run: async (c) => { const u = await c.eu(); return { d: u, t: `${u.id}  ${u.username}  <${u.email}>` }; },
  },
  setup: { uso: "setup                                  pede o token (pk_...), valida e grava ~/.clickup.toml (0600)", run: cmdSetup },
  team: {
    uso: "team                                   workspaces que o token enxerga",
    run: async (c) => { const d = await c.times(); return { d, t: d.map((t) => `${t.id}  ${t.name}  (${t.members?.length ?? 0} membros)`).join("\n") }; },
  },
  "member ls": {
    uso: "member ls                              membros do workspace (id pra --assignee/--owner)",
    run: async (c) => { const d = await c.membros(); return { d, t: d.map((u) => `${u.id}  ${u.username}  <${u.email}>`).join("\n") }; },
  },
  tree: {
    uso: "tree [SPACE_ID]                        spaces > folders > listas, com os ids",
    run: async (c) => {
      const team = await c.team();
      let spaces = (await c.cu.req("GET", `/team/${team}/space`)).spaces || [];
      if (c.pos[0]) spaces = spaces.filter((s) => String(s.id) === c.pos[0]);
      const l = [];
      for (const s of spaces) {
        const [fo, li] = await Promise.all([c.cu.req("GET", `/space/${s.id}/folder`), c.cu.req("GET", `/space/${s.id}/list`)]);
        s.folders = fo.folders || []; s.lists = li.lists || [];
        l.push(`space ${s.id}  ${s.name}`);
        for (const x of s.lists) l.push(`  list ${x.id}  ${x.name}`);
        for (const p of s.folders) {
          l.push(`  folder ${p.id}  ${p.name}`);
          for (const x of p.lists || []) l.push(`    list ${x.id}  ${x.name}`);
        }
      }
      return { d: spaces, t: l.join("\n") || "nenhum space" };
    },
  },
  "list get": {
    uso: "list get LIST_ID                       a lista e os status válidos dela", args: 1,
    run: async (c) => {
      const d = await c.cu.req("GET", `/list/${c.pos[0]}`);
      return { d, t: `${d.id}  ${d.name}  (${junta(d.space?.name, d.folder?.name)})\n  status: ${(d.statuses || []).map((s) => s.status).join(" | ")}` };
    },
  },

  "task create": {
    uso: `task create LIST_ID NOME [--desc MD] [--status S] [--priority P] [--assignee U ...] [--tag T ...]
                [--due D] [--start D] [--parent ID] [--points N] [--type ID_TIPO] [--field ID=VALOR ...] [--links-to ID]`,
    args: 2, flags: ["desc", "status", "priority", "assignee", "tag", "due", "start", "parent", "points", "type", "field", "links-to"],
    run: async (c) => {
      const { f, pos } = c;
      const body = limpo({
        name: pos[1], markdown_content: texto(f.um("desc")), status: f.um("status"),
        priority: f.tem("priority") ? prioridade(f.um("priority")) : undefined,
        assignees: await c.usuarios("assignee"), tags: f.varios("tag"), ...datas(f),
        parent: f.um("parent"), links_to: f.um("links-to"),
        points: f.tem("points") ? num(f.um("points"), "points") : undefined,
        custom_item_id: f.tem("type") ? num(f.um("type"), "type") : undefined,
        custom_fields: f.varios("field").map((kv) => {
          const i = kv.indexOf("=");
          if (i < 1) die(`--field espera ID=VALOR: ${kv}`);
          return { id: kv.slice(0, i), value: jsonOuTexto(kv.slice(i + 1)) };
        }),
      });
      const d = await c.cu.req("POST", `/list/${pos[0]}/task`, { body });
      return { d, t: `criada ${d.id}  ${d.url}` };
    },
  },
  "task get": {
    uso: "task get TASK_ID [--subtasks]", args: 1, flags: ["subtasks"],
    run: async (c) => {
      const d = await c.cu.req("GET", `/task/${c.pos[0]}`, { query: { include_markdown_description: true, include_subtasks: c.f.tem("subtasks") } });
      return { d, t: detalheTask(d) };
    },
  },
  "task ls": {
    uso: `task ls [LIST_ID] [--status S ...] [--assignee U ...] [--tag T ...] [--name TRECHO] [--closed] [--subtasks] [--page N]
                sem LIST_ID lista o workspace inteiro (aceita --list ID ... e --space ID ...)`,
    flags: [...FILTROS, "list", "space"],
    run: async (c) =>
      c.pos[0]
        ? listarTasks(c, `/list/${c.pos[0]}/task`)
        : listarTasks(c, `/team/${await c.team()}/task`, { list_ids: c.f.varios("list"), space_ids: c.f.varios("space") }),
  },
  "task update": {
    uso: `task update TASK_ID [--name N] [--desc MD] [--status S] [--priority P|none] [--due D] [--start D]
                [--assignee-add U ...] [--assignee-rm U ...] [--parent ID] [--points N] [--archive]`,
    args: 1, flags: ["name", "desc", "status", "priority", "due", "start", "assignee-add", "assignee-rm", "parent", "points", "archive"],
    run: async (c) => {
      const { f } = c;
      const [add, rem] = [await c.usuarios("assignee-add"), await c.usuarios("assignee-rm")];
      const body = limpo({
        name: f.um("name"), markdown_content: texto(f.um("desc")), status: f.um("status"),
        priority: f.tem("priority") ? prioridade(f.um("priority")) : undefined, ...datas(f),
        parent: f.um("parent"), points: f.tem("points") ? num(f.um("points"), "points") : undefined,
        archived: f.tem("archive") ? true : undefined,
        assignees: add.length || rem.length ? { add, rem } : undefined,
      });
      if (!Object.keys(body).length) die("task update: nada a alterar");
      const d = await c.cu.req("PUT", `/task/${c.pos[0]}`, { body });
      return { d, t: `atualizada ${linhaTask(d)}` };
    },
  },
  "task rm": {
    uso: "task rm TASK_ID --yes", args: 1, flags: ["yes"],
    run: async (c) => { confirmado(c.f, "apagar task"); const d = await c.cu.req("DELETE", `/task/${c.pos[0]}`); return { d, t: `apagada ${c.pos[0]}` }; },
  },

  "comment add": {
    uso: "comment add TASK_ID TEXTO [--assignee U] [--notify]     TEXTO: `-` lê do stdin, `@arquivo` lê do arquivo", args: 2, flags: ["assignee", "notify"],
    run: async (c) => {
      const body = limpo({ comment_text: texto(c.pos[1]), notify_all: c.f.tem("notify"),
                           assignee: c.f.tem("assignee") ? await c.usuario(c.f.um("assignee")) : undefined });
      const d = await c.cu.req("POST", `/task/${c.pos[0]}/comment`, { body });
      return { d, t: `comentado ${d.id}` };
    },
  },
  "comment ls": {
    uso: "comment ls TASK_ID", args: 1,
    run: async (c) => {
      const d = (await c.cu.req("GET", `/task/${c.pos[0]}/comment`)).comments || [];
      const t = d.map((x) => `${x.id}  ${x.user?.username ?? "?"}  ${dia(x.date)}${x.resolved ? "  (resolvido)" : ""}\n${(x.comment_text || "").trim().replace(/^/gm, "    ")}`).join("\n");
      return { d, t: t || "sem comentários" };
    },
  },
  "comment reply": {
    uso: "comment reply COMMENT_ID TEXTO", args: 2,
    run: async (c) => { const d = await c.cu.req("POST", `/comment/${c.pos[0]}/reply`, { body: { comment_text: texto(c.pos[1]) } }); return { d, t: `respondido ${c.pos[0]}` }; },
  },
  "comment update": {
    uso: "comment update COMMENT_ID TEXTO [--resolved]", args: 2, flags: ["resolved"],
    run: async (c) => {
      const d = await c.cu.req("PUT", `/comment/${c.pos[0]}`, { body: { comment_text: texto(c.pos[1]), resolved: c.f.tem("resolved") } });
      return { d, t: `atualizado ${c.pos[0]}` };
    },
  },
  "comment rm": {
    uso: "comment rm COMMENT_ID --yes", args: 1, flags: ["yes"],
    run: async (c) => { confirmado(c.f, "apagar comentário"); const d = await c.cu.req("DELETE", `/comment/${c.pos[0]}`); return { d, t: `apagado ${c.pos[0]}` }; },
  },

  "link add": {
    uso: "link add TASK_ID OUTRA_ID              liga duas tasks (relação simples, sem bloqueio)", args: 2,
    run: async (c) => { const d = await c.cu.req("POST", `/task/${c.pos[0]}/link/${c.pos[1]}`); return { d, t: `ligadas ${c.pos[0]} <-> ${c.pos[1]}` }; },
  },
  "link rm": {
    uso: "link rm TASK_ID OUTRA_ID", args: 2,
    run: async (c) => { const d = await c.cu.req("DELETE", `/task/${c.pos[0]}/link/${c.pos[1]}`); return { d, t: `desligadas ${c.pos[0]} <-> ${c.pos[1]}` }; },
  },
  "dep add": {
    uso: "dep add TASK_ID (--depends-on ID | --blocks ID)        TASK espera a outra, ou TASK bloqueia a outra", args: 1, flags: ["depends-on", "blocks"],
    run: async (c) => { const body = dependencia(c.f); const d = await c.cu.req("POST", `/task/${c.pos[0]}/dependency`, { body }); return { d, t: `dependência criada em ${c.pos[0]}` }; },
  },
  "dep rm": {
    uso: "dep rm TASK_ID (--depends-on ID | --blocks ID)", args: 1, flags: ["depends-on", "blocks"],
    run: async (c) => { const query = dependencia(c.f); const d = await c.cu.req("DELETE", `/task/${c.pos[0]}/dependency`, { query }); return { d, t: `dependência removida de ${c.pos[0]}` }; },
  },

  "tag ls": {
    uso: "tag ls SPACE_ID", args: 1,
    run: async (c) => { const d = (await c.cu.req("GET", `/space/${c.pos[0]}/tag`)).tags || []; return { d, t: d.map((x) => x.name).join("\n") || "sem tags" }; },
  },
  "tag add": {
    uso: "tag add TASK_ID TAG", args: 2,
    run: async (c) => { const d = await c.cu.req("POST", `/task/${c.pos[0]}/tag/${encodeURIComponent(c.pos[1])}`); return { d, t: `tag ${c.pos[1]} em ${c.pos[0]}` }; },
  },
  "tag rm": {
    uso: "tag rm TASK_ID TAG", args: 2,
    run: async (c) => { const d = await c.cu.req("DELETE", `/task/${c.pos[0]}/tag/${encodeURIComponent(c.pos[1])}`); return { d, t: `tag ${c.pos[1]} fora de ${c.pos[0]}` }; },
  },

  "field ls": {
    uso: "field ls LIST_ID                       custom fields da lista (id, tipo, opções)", args: 1,
    run: async (c) => {
      const d = (await c.cu.req("GET", `/list/${c.pos[0]}/field`)).fields || [];
      const op = (x) => (x.type_config?.options || []).map((o) => `${o.name ?? o.label}=${o.id}`).join(", ");
      return { d, t: d.map((x) => junta(x.id, `[${x.type}]`, x.name, op(x) && `opções: ${op(x)}`)).join("\n") || "sem custom fields" };
    },
  },
  "field set": {
    uso: "field set TASK_ID FIELD_ID VALOR       VALOR em JSON quando o tipo pede (número, array, objeto); senão texto", args: 3,
    run: async (c) => { const d = await c.cu.req("POST", `/task/${c.pos[0]}/field/${c.pos[1]}`, { body: { value: jsonOuTexto(c.pos[2]) } }); return { d, t: `campo ${c.pos[1]} gravado em ${c.pos[0]}` }; },
  },
  "field rm": {
    uso: "field rm TASK_ID FIELD_ID              limpa o valor do campo na task", args: 2,
    run: async (c) => { const d = await c.cu.req("DELETE", `/task/${c.pos[0]}/field/${c.pos[1]}`); return { d, t: `campo ${c.pos[1]} limpo em ${c.pos[0]}` }; },
  },

  "goal ls": {
    uso: "goal ls [--completed]", flags: ["completed"],
    run: async (c) => {
      const d = await c.cu.req("GET", `/team/${await c.team()}/goal`, { query: { include_completed: c.f.tem("completed") } });
      const l = (d.goals || []).map(linhaGoal);
      for (const p of d.folders || []) { l.push(`pasta ${p.id}  ${p.name}`); for (const g of p.goals || []) l.push("  " + linhaGoal(g)); }
      return { d, t: l.join("\n") || "nenhum goal" };
    },
  },
  "goal get": {
    uso: "goal get GOAL_ID                       o goal com os key results (targets)", args: 1,
    run: async (c) => { const d = (await c.cu.req("GET", `/goal/${c.pos[0]}`)).goal; return { d, t: detalheGoal(d) }; },
  },
  "goal create": {
    uso: "goal create NOME --due D [--desc TXT] [--owner U ...] [--color #hex]     sem --owner o dono és tu", args: 1, flags: ["due", "desc", "owner", "color"],
    run: async (c) => {
      const { f } = c;
      if (!f.tem("due")) die("goal create: --due é obrigatório na API");
      const owners = f.tem("owner") ? await c.usuarios("owner") : [(await c.eu()).id];
      const body = { name: c.pos[0], due_date: parseData(f.um("due")).ms, description: texto(f.um("desc")) ?? "",
                     multiple_owners: owners.length > 1, owners, color: f.um("color") ?? "#32a852" };
      const d = (await c.cu.req("POST", `/team/${await c.team()}/goal`, { body })).goal;
      return { d, t: `criado ${d.id}  ${d.pretty_url ?? ""}`.trim() };
    },
  },
  "goal update": {
    uso: "goal update GOAL_ID [--name N] [--due D] [--desc TXT] [--color #hex] [--owner-add U ...] [--owner-rm U ...]", args: 1,
    flags: ["name", "due", "desc", "color", "owner-add", "owner-rm"],
    run: async (c) => {
      const { f } = c;
      const body = limpo({ name: f.um("name"), due_date: f.tem("due") ? parseData(f.um("due")).ms : undefined, description: texto(f.um("desc")),
                           color: f.um("color"), add_owners: await c.usuarios("owner-add"), rem_owners: await c.usuarios("owner-rm") });
      if (!Object.keys(body).length) die("goal update: nada a alterar");
      const d = (await c.cu.req("PUT", `/goal/${c.pos[0]}`, { body })).goal;
      return { d, t: `atualizado ${linhaGoal(d)}` };
    },
  },
  "goal rm": {
    uso: "goal rm GOAL_ID --yes", args: 1, flags: ["yes"],
    run: async (c) => { confirmado(c.f, "apagar goal"); const d = await c.cu.req("DELETE", `/goal/${c.pos[0]}`); return { d, t: `apagado ${c.pos[0]}` }; },
  },

  "kr create": {
    uso: `kr create GOAL_ID NOME [--type ${TIPOS_KR.join("|")}] [--start N] [--end N] [--unit U]
                [--owner U ...] [--task ID ...] [--list ID ...]
                com --task/--list o tipo padrão é automatic (o progresso vem das tasks); senão number`,
    args: 2, flags: ["type", "start", "end", "unit", "owner", "task", "list"],
    run: async (c) => {
      const { f } = c;
      const [tasks, listas] = [f.varios("task"), f.varios("list")];
      const type = f.um("type") ?? (tasks.length || listas.length ? "automatic" : "number");
      if (!TIPOS_KR.includes(type)) die(`--type inválido: ${type} (${TIPOS_KR.join("|")})`);
      if (["number", "currency", "percentage"].includes(type) && !f.tem("end")) die(`kr ${type} precisa de --end (a meta)`);
      const body = {
        name: c.pos[1], owners: f.tem("owner") ? await c.usuarios("owner") : [(await c.eu()).id], type,
        steps_start: f.tem("start") ? num(f.um("start"), "start") : 0,
        steps_end: f.tem("end") ? num(f.um("end"), "end") : type === "boolean" ? 1 : 0,
        unit: f.um("unit") ?? "", task_ids: tasks, list_ids: listas,
      };
      const d = (await c.cu.req("POST", `/goal/${c.pos[0]}/key_result`, { body })).key_result;
      return { d, t: `criado ${linhaKr(d)}` };
    },
  },
  "kr update": {
    uso: `kr update KR_ID [--current N] [--note TXT] [--name N] [--end N] [--unit U] [--task ID ...] [--list ID ...]
                --current registra o progresso; --task/--list SUBSTITUEM o conjunto (pra somar: kr add-task)`,
    args: 1, flags: ["current", "note", "name", "end", "unit", "task", "list"],
    run: async (c) => {
      const { f } = c;
      const body = limpo({ steps_current: f.tem("current") ? num(f.um("current"), "current") : undefined,
                           note: f.um("note") ?? (f.tem("current") ? "" : undefined), name: f.um("name"),
                           steps_end: f.tem("end") ? num(f.um("end"), "end") : undefined, unit: f.um("unit"),
                           task_ids: f.varios("task"), list_ids: f.varios("list") });
      if (!Object.keys(body).length) die("kr update: nada a alterar");
      const d = (await c.cu.req("PUT", `/key_result/${c.pos[0]}`, { body })).key_result;
      return { d, t: `atualizado ${linhaKr(d)}` };
    },
  },
  "kr add-task": {
    uso: "kr add-task GOAL_ID KR_ID TASK_ID ...  soma tasks a um key result automatic sem perder as que já estão", args: 3,
    run: async (c) => {
      const [goalId, krId, ...novas] = c.pos;
      const kr = ((await c.cu.req("GET", `/goal/${goalId}`)).goal?.key_results || []).find((k) => k.id === krId);
      if (!kr) die(`key result ${krId} não está no goal ${goalId}`);
      const task_ids = [...new Set([...(kr.task_ids || []), ...novas])];
      const d = (await c.cu.req("PUT", `/key_result/${krId}`, { body: { task_ids } })).key_result;
      return { d, t: `atualizado ${linhaKr(d)}` };
    },
  },
  "kr rm": {
    uso: "kr rm KR_ID --yes", args: 1, flags: ["yes"],
    run: async (c) => { confirmado(c.f, "apagar key result"); const d = await c.cu.req("DELETE", `/key_result/${c.pos[0]}`); return { d, t: `apagado ${c.pos[0]}` }; },
  },

  api: {
    uso: `api MÉTODO CAMINHO [--body JSON] [--query K=V ...]
                chamada crua pro que não tem comando; caminho sem versão vai pra v2, /v3/... passa direto. Sempre JSON`,
    args: 2, flags: ["body", "query"],
    run: async (c) => {
      const query = {};
      for (const kv of c.f.varios("query")) {
        const i = kv.indexOf("=");
        if (i < 1) die(`--query espera K=V: ${kv}`);
        const [k, v] = [kv.slice(0, i), kv.slice(i + 1)];
        if (k.endsWith("[]")) (query[k.slice(0, -2)] ??= []).push(v); else query[k] = v;
      }
      let body;
      if (c.f.tem("body")) { try { body = JSON.parse(texto(c.f.um("body"))); } catch (e) { die(`--body não é JSON: ${e.message}`); } }
      const d = await c.cu.req(c.pos[0].toUpperCase(), c.pos[1].startsWith("/") ? c.pos[1] : "/" + c.pos[1], { query, body });
      return { d, t: JSON.stringify(d, null, 2) };
    },
  },
};

function dependencia(f) {
  if (f.tem("depends-on") === f.tem("blocks")) die("passa exatamente um: --depends-on ID ou --blocks ID");
  return f.tem("depends-on") ? { depends_on: f.um("depends-on") } : { dependency_of: f.um("blocks") };
}

async function cmdSetup(c) {
  const p = caminhoConfig(c.env);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let token;
  try {
    console.error(`Token pessoal: ClickUp > avatar > Settings > Apps > API Token (começa com pk_). Vai pra ${p} (0600).`);
    if (existsSync(p) && !/^s/i.test(await rl.question(`${p} já existe. Sobrescrever? [s/N] `))) return { d: null, t: "deixei como estava." };
    token = (await rl.question("token: ")).trim();
  } finally { rl.close(); }
  if (!token.startsWith("pk_")) die("isso não parece um token do ClickUp (começa com pk_)");
  const cu = new ClickUp(token, c.cu.base);
  const eu = (await cu.req("GET", "/user")).user;
  const times = (await cu.req("GET", "/team")).teams || [];
  // um workspace só: já grava o team_id e ninguém precisa passar --team
  const linhas = [`token = ${JSON.stringify(token)}`, ...(times.length === 1 ? [`team_id = "${times[0].id}"`] : [])];
  writeFileSync(p, `# clickup-cli — token pessoal do ClickUp. Nunca commitar.\n${linhas.join("\n")}\n`, { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch {}
  return { d: eu, t: `ok: ${eu.username} <${eu.email}>, gravado ${p}` };
}

// ---------------------------------------------------------------- main

export function ajuda(prefixo = "") {
  const linhas = Object.entries(CMD).filter(([k]) => !prefixo || k === prefixo || k.startsWith(prefixo + " ")).map(([, v]) => "  clickup " + v.uso);
  return `clickup ${VERSAO} — CLI do ClickUp (API v2)

${linhas.join("\n")}

Globais: --json (resposta crua da API)  --team ID (workspace)  --help
Usuário (U): id, \`me\`, ou trecho do username/email.  Data (D): AAAA-MM-DD, AAAA-MM-DDTHH:MM ou ms.
Token: CLICKUP_TOKEN, ou \`clickup setup\` (~/.clickup.toml), ou o ~/.clickup-flow.toml que já existe.`;
}

export async function main(argv, { env = process.env, out = console.log } = {}) {
  const { pos, flags } = parseArgv(argv);
  if (flags.tem("version")) return out(VERSAO);
  const chave = CMD[`${pos[0]} ${pos[1]}`] ? `${pos[0]} ${pos[1]}` : CMD[pos[0]] ? pos[0] : null;
  if (flags.tem("help") || !pos.length) return out(ajuda(chave ?? pos[0] ?? ""));
  if (!chave) {
    const doRecurso = Object.keys(CMD).filter((k) => k.startsWith(pos[0] + " "));
    die(doRecurso.length ? `${pos[0]}: ação ${pos[1] ? `"${pos[1]}" desconhecida` : "faltando"} (${doRecurso.map((k) => k.split(" ")[1]).join(" | ")})`
                         : `comando desconhecido: ${pos[0]}  (clickup --help)`);
  }
  const cmd = CMD[chave];
  const resto = pos.slice(chave.split(" ").length);
  const aceitas = [...(cmd.flags || []), ...GLOBAIS];
  const estranha = Object.keys(flags.m).find((k) => !aceitas.includes(k));
  if (estranha) die(`${chave}: flag desconhecida --${estranha}\n  clickup ${cmd.uso}`);
  if (resto.length < (cmd.args || 0)) die(`faltam argumentos\n  clickup ${cmd.uso}`);

  const cfg = lerConfig(env);
  if (!cfg.token && chave !== "setup") die("sem token do ClickUp — roda `clickup setup` ou exporta CLICKUP_TOKEN", 2);
  const cu = new ClickUp(cfg.token, env.CLICKUP_API_BASE);
  const c = contexto(cu, flags, cfg);
  c.pos = resto; c.env = env;
  const { d, t } = await cmd.run(c);
  out(flags.tem("json") || chave === "api" ? JSON.stringify(d, null, 2) : t);
}
