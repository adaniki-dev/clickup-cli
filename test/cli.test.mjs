// Roda o CLI inteiro contra um ClickUp falso em HTTP local: o que se confere é o que saiu no fio.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { main, parseArgv, parseData } from "../src/cli.mjs";

let srv, base, pedidos, rotas;
const EU = { id: 7, username: "adam", email: "adam@x.dev" };
const TIME = { id: "900", name: "Sourei", members: [{ user: EU }, { user: { id: 8, username: "Bia Souza", email: "bia@x.dev" } }, { user: { id: 9, username: "Bianca", email: "bianca@x.dev" } }] };

before(async () => {
  srv = createServer((req, res) => {
    let txt = "";
    req.on("data", (c) => (txt += c));
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      pedidos.push({ m: req.method, p: u.pathname, q: u.search, body: txt ? JSON.parse(txt) : undefined, auth: req.headers.authorization });
      const r = rotas[`${req.method} ${u.pathname}`];
      const [status, corpo] = r === undefined ? [404, { err: "Route not found", ECODE: "APP_001" }] : Array.isArray(r) ? r : [200, r];
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(corpo));
    });
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => srv.close());
beforeEach(() => {
  pedidos = [];
  rotas = { "GET /api/v2/user": { user: EU }, "GET /api/v2/team": { teams: [TIME] } };
});

/** Roda o CLI e devolve o que ele imprimiu. */
async function cli(args, env = {}) {
  const saida = [];
  await main(args, { env: { CLICKUP_TOKEN: "pk_teste", CLICKUP_API_BASE: base, CLICKUP_CONFIG: "/nao/existe.toml", ...env }, out: (s) => saida.push(s) });
  return saida.join("\n");
}
const ultimo = () => pedidos.at(-1);

test("task create: resolve `me` e nome de membro, traduz prioridade, data sem hora e custom field", async () => {
  rotas["POST /api/v2/list/L1/task"] = { id: "abc", url: "https://app.clickup.com/t/abc" };
  const out = await cli(["task", "create", "L1", "Checkout pix", "--desc", "**md**", "--priority", "high", "--assignee", "me", "--assignee", "souza",
                         "--tag", "bug", "--due", "2026-11-20", "--points", "3", "--field", "f1=42", "--field", "f2=texto livre"]);
  assert.equal(out, "criada abc  https://app.clickup.com/t/abc");
  assert.equal(ultimo().auth, "pk_teste");
  assert.deepEqual(ultimo().body, {
    name: "Checkout pix", markdown_content: "**md**", priority: 2, assignees: [7, 8], tags: ["bug"],
    due_date: new Date(2026, 10, 20).getTime(), due_date_time: false, points: 3,
    custom_fields: [{ id: "f1", value: 42 }, { id: "f2", value: "texto livre" }],
  });
});

test("membro ambíguo ou inexistente trava antes de criar qualquer coisa", async () => {
  await assert.rejects(cli(["task", "create", "L1", "x", "--assignee", "bia"]), /bate em 2 membros \(Bia Souza, Bianca\)/);
  await assert.rejects(cli(["task", "create", "L1", "x", "--assignee", "zeca"]), /bate em 0 membros/);
  assert.ok(!pedidos.some((p) => p.m === "POST"));
});

test("task update: assignees vira add/rem, `--priority none` limpa, e sem flag nenhuma não chama a API", async () => {
  rotas["PUT /api/v2/task/abc"] = { id: "abc", name: "n", status: { status: "in review" } };
  await cli(["task", "update", "abc", "--status", "in review", "--priority", "none", "--assignee-add", "8", "--assignee-rm", "me"]);
  assert.deepEqual(ultimo().body, { status: "in review", priority: null, assignees: { add: [8], rem: [7] } });
  pedidos = [];
  await assert.rejects(cli(["task", "update", "abc"]), /nada a alterar/);
  assert.equal(pedidos.length, 0);
});

test("task ls: sem lista vai no workspace descoberto pelo token; filtros viram chave[]", async () => {
  rotas["GET /api/v2/team/900/task"] = { tasks: [{ id: "t1", name: "Um", status: { status: "open" }, assignees: [EU] }], last_page: true };
  const out = await cli(["task", "ls", "--assignee", "me", "--status", "open", "--status", "in progress", "--list", "L1"]);
  assert.equal(out, "t1  [open]  Um  @adam");
  const q = new URLSearchParams(ultimo().q);
  assert.deepEqual(q.getAll("statuses[]"), ["open", "in progress"]);
  assert.deepEqual(q.getAll("assignees[]"), ["7"]);
  assert.deepEqual(q.getAll("list_ids[]"), ["L1"]);
});

test("task ls --name varre as páginas e filtra; sem --name avisa que há mais", async () => {
  let n = 0;
  const paginas = [{ tasks: [{ id: "a", name: "Login" }], last_page: false }, { tasks: [{ id: "b", name: "Pix checkout" }], last_page: true }];
  Object.defineProperty(rotas, "GET /api/v2/list/L1/task", { get: () => paginas[n++], enumerable: true });
  assert.equal(await cli(["task", "ls", "L1", "--name", "pix"]), "b  [?]  Pix checkout");
  assert.deepEqual(pedidos.filter((p) => p.p.endsWith("/task")).map((p) => new URLSearchParams(p.q).get("page")), ["0", "1"]);
  n = 0;
  assert.match(await cli(["task", "ls", "L1"]), /a  \[\?\]  Login\n\(há mais: --page 1\)/);
});

test("workspace: mais de um exige --team; --team e CLICKUP_TEAM_ID dispensam a descoberta", async () => {
  rotas["GET /api/v2/team"] = { teams: [TIME, { id: "901", name: "Outro", members: [] }] };
  await assert.rejects(cli(["goal", "ls"]), /enxerga 2 workspaces \(900 Sourei, 901 Outro\)/);
  rotas["GET /api/v2/team/901/goal"] = { goals: [], folders: [] };
  assert.equal(await cli(["goal", "ls", "--team", "901"]), "nenhum goal");
  rotas["GET /api/v2/team/555/goal"] = { goals: [], folders: [] };
  pedidos = [];
  await cli(["goal", "ls"], { CLICKUP_TEAM_ID: "555" });
  assert.deepEqual(pedidos.map((p) => p.p), ["/api/v2/team/555/goal"]);
});

test("goal create: dono padrão sou eu, --due obrigatório", async () => {
  rotas["POST /api/v2/team/900/goal"] = { goal: { id: "g1", pretty_url: "https://app.clickup.com/900/goals/1" } };
  await assert.rejects(cli(["goal", "create", "Q4"]), /--due é obrigatório/);
  assert.equal(await cli(["goal", "create", "Q4", "--due", "1800000000000"]), "criado g1  https://app.clickup.com/900/goals/1");
  assert.deepEqual(ultimo().body, { name: "Q4", due_date: 1800000000000, description: "", multiple_owners: false, owners: [7], color: "#32a852" });
});

test("kr create: com --task o tipo vira automatic; number sem --end trava", async () => {
  rotas["POST /api/v2/goal/g1/key_result"] = { key_result: { id: "k1", type: "automatic", name: "Entregas", task_ids: ["abc"] } };
  await cli(["kr", "create", "g1", "Entregas", "--task", "abc"]);
  assert.deepEqual(ultimo().body, { name: "Entregas", owners: [7], type: "automatic", steps_start: 0, steps_end: 0, unit: "", task_ids: ["abc"], list_ids: [] });
  pedidos = [];
  await assert.rejects(cli(["kr", "create", "g1", "MRR", "--type", "currency"]), /precisa de --end/);
  assert.ok(!pedidos.some((p) => p.m === "POST"));
});

test("kr add-task soma às tasks que o key result já tinha, sem duplicar", async () => {
  rotas["GET /api/v2/goal/g1"] = { goal: { id: "g1", key_results: [{ id: "k1", task_ids: ["a", "b"] }] } };
  rotas["PUT /api/v2/key_result/k1"] = { key_result: { id: "k1", type: "automatic", name: "E" } };
  await cli(["kr", "add-task", "g1", "k1", "b", "c"]);
  assert.deepEqual(ultimo().body, { task_ids: ["a", "b", "c"] });
  await assert.rejects(cli(["kr", "add-task", "g1", "nope", "c"]), /não está no goal g1/);
});

test("kr update --current manda nota vazia junto (a API exige as duas)", async () => {
  rotas["PUT /api/v2/key_result/k1"] = { key_result: { id: "k1", type: "number", name: "E" } };
  await cli(["kr", "update", "k1", "--current", "5"]);
  assert.deepEqual(ultimo().body, { steps_current: 5, note: "" });
});

test("dep: add manda no corpo, rm manda na query; os dois lados juntos ou nenhum travam", async () => {
  rotas["POST /api/v2/task/a/dependency"] = {}; rotas["DELETE /api/v2/task/a/dependency"] = {};
  await cli(["dep", "add", "a", "--depends-on", "b"]);
  assert.deepEqual(ultimo().body, { depends_on: "b" });
  await cli(["dep", "rm", "a", "--blocks", "c"]);
  assert.equal(ultimo().q, "?dependency_of=c"); assert.equal(ultimo().body, undefined);
  await assert.rejects(cli(["dep", "add", "a"]), /exatamente um/);
  await assert.rejects(cli(["dep", "add", "a", "--depends-on", "b", "--blocks", "c"]), /exatamente um/);
});

test("apagar sem --yes não chega na API", async () => {
  for (const args of [["task", "rm", "abc"], ["goal", "rm", "g1"], ["kr", "rm", "k1"], ["comment", "rm", "55"]])
    await assert.rejects(cli(args), /irreversível/);
  assert.equal(pedidos.length, 0);
  rotas["DELETE /api/v2/task/abc"] = {};
  assert.equal(await cli(["task", "rm", "abc", "--yes"]), "apagada abc");
});

test("flag desconhecida e argumento faltando travam com o uso, sem chamar a API", async () => {
  await assert.rejects(cli(["task", "create", "L1", "x", "--prioridade", "high"]), /flag desconhecida --prioridade[\s\S]*task create LIST_ID/);
  await assert.rejects(cli(["comment", "add", "abc"]), /faltam argumentos/);
  await assert.rejects(cli(["task", "explode"]), /ação "explode" desconhecida \(create \| get \| ls \| update \| rm\)/);
  assert.equal(pedidos.length, 0);
});

test("erro da API sobe com status, mensagem e código do ClickUp", async () => {
  rotas["GET /api/v2/task/x"] = [401, { err: "Team not authorized", ECODE: "OAUTH_027" }];
  await assert.rejects(cli(["task", "get", "x"]), /GET \/api\/v2\/task\/x: HTTP 401 Team not authorized \(OAUTH_027\)/);
});

test("sem token: sai com código 2 e a dica do setup", async () => {
  await assert.rejects(cli(["whoami"], { CLICKUP_TOKEN: "" }), (e) => e.code === 2 && /clickup setup/.test(e.message));
});

test("api: caminho sem versão vai pra v2, /v3 passa direto, query repetida vira array", async () => {
  rotas["GET /api/v3/workspaces/900/docs"] = { docs: [] };
  rotas["POST /api/v2/list/L1/task"] = { id: "z" };
  assert.equal(await cli(["api", "get", "/v3/workspaces/900/docs", "--query", "ids[]=1", "--query", "ids[]=2"]), '{\n  "docs": []\n}');
  assert.deepEqual(new URLSearchParams(ultimo().q).getAll("ids[]"), ["1", "2"]);
  await cli(["api", "POST", "list/L1/task", "--body", '{"name":"cru"}']);
  assert.deepEqual([ultimo().p, ultimo().body], ["/api/v2/list/L1/task", { name: "cru" }]);
  await assert.rejects(cli(["api", "POST", "/x", "--body", "{nope"]), /--body não é JSON/);
});

test("--json devolve a resposta crua em vez do texto", async () => {
  rotas["GET /api/v2/goal/g1"] = { goal: { id: "g1", name: "Q4", key_results: [] } };
  assert.deepEqual(JSON.parse(await cli(["goal", "get", "g1", "--json"])), { id: "g1", name: "Q4", key_results: [] });
});

test("parseArgv: --k=v com `=` no valor, flag repetida acumula, `--` encerra as flags", () => {
  const { pos, flags } = parseArgv(["a", "--field=f1=a=b", "--tag", "x", "--tag", "y", "--json", "--", "--literal"]);
  assert.deepEqual(pos, ["a", "--literal"]);
  assert.equal(flags.um("field"), "f1=a=b"); assert.deepEqual(flags.varios("tag"), ["x", "y"]); assert.ok(flags.tem("json"));
  assert.throws(() => parseArgv(["--status"]), /precisa de valor/);
});

test("parseData: dia sem hora, data com hora, ms cru, lixo trava", () => {
  assert.deepEqual(parseData("2026-11-20"), { ms: new Date(2026, 10, 20).getTime(), hora: false });
  assert.deepEqual(parseData("2026-11-20T15:30"), { ms: new Date(2026, 10, 20, 15, 30).getTime(), hora: true });
  assert.deepEqual(parseData("1800000000000"), { ms: 1800000000000, hora: true });
  assert.throws(() => parseData("amanhã"), /data inválida/);
});
