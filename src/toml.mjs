// TOML mínimo: chave = "string" | 123 | true | ["a", "b"]; seções [a] e [a.b]. Sem inline table, sem multiline.
export function parseToml(txt) {
  const root = {};
  let cur = root;
  txt.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) return;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      cur = root;
      for (const p of sec[1].split(".").map((s) => s.trim())) cur = (cur[p] ??= {});
      return;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) throw new Error(`toml linha ${i + 1}: não entendi: ${raw}`);
    cur[kv[1]] = valor(kv[2].trim(), i + 1);
  });
  return root;
}

function valor(v, linha) {
  if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return v.slice(1, -1);
  if (v === "true" || v === "false") return v === "true";
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    return inner ? inner.split(",").map((x) => valor(x.trim(), linha)) : [];
  }
  throw new Error(`toml linha ${linha}: valor inválido: ${v}`);
}
