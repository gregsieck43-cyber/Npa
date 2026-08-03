import vm from "node:vm";

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });
}

function stats(rows, column) {
  const values = rows.map((row) => row?.[column]).filter((value) => typeof value === "number" && Number.isFinite(value));
  if (!values.length) return { count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((total, value) => total + value, 0);
  return { count: values.length, sum, mean: sum / values.length, min: sorted[0], max: sorted.at(-1), median: sorted[Math.floor(sorted.length / 2)] };
}

function groupBy(rows, column) {
  const groups = Object.create(null);
  for (const row of rows) {
    const key = String(row?.[column] ?? "");
    groups[key] ||= [];
    groups[key].push(row);
  }
  return groups;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function main() {
  const payload = JSON.parse(await readStdin());
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const columns = Array.isArray(payload.columns) ? payload.columns : [];
  const logs = [];
  const context = vm.createContext(Object.assign(Object.create(null), {
    rows,
    columns,
    dataset: payload.dataset || {},
    result: null,
    chart: null,
    table: null,
    console: {
      log: (...args) => logs.push(args.map((arg) => (typeof arg === "string" ? arg : safeJson(arg))).join(" "))
    },
    helpers: {
      stats: (column) => stats(rows, column),
      groupBy: (column) => groupBy(rows, column)
    },
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Date
  }), {
    codeGeneration: { strings: false, wasm: false }
  });
  const script = new vm.Script(String(payload.code || ""), { displayErrors: true });
  script.runInContext(context, {
    timeout: Math.max(500, Number(payload.timeoutMs || 3000)),
    breakOnSigint: true
  });
  const output = {
    stdout: logs.join("\n"),
    stderr: "",
    result: context.result ?? null,
    chart: context.chart ?? null,
    table: Array.isArray(context.table) ? context.table.slice(0, 200) : null
  };
  process.stdout.write(`__RESULT_JSON__${JSON.stringify(output)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  process.exitCode = 1;
});
