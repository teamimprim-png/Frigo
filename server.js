const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const sseClients = new Set();

const requestedPort = Number(process.argv[2] || process.env.PORT);
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 4173;
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "frigo-state.json");
const ASSETS_DIR = path.join(ROOT, "assets");

const memberGroups = {
  chauffeur: "Chauffeur",
  maintenance: "Maintenance",
  cadre: "Cadre",
  photograveur: "Photograveur",
  depart: "Départ",
  roto: "Roto",
  autre: "Autre",
};

const demoState = {
  products: [
    { id: randomUUID(), name: "Coca", price: 1.2, category: "drink", location: "fridge", displayStock: 12, reserveStock: 24 },
    { id: randomUUID(), name: "Eau petillante", price: 0.8, category: "drink", location: "fridge", displayStock: 10, reserveStock: 18 },
    { id: randomUUID(), name: "Barre chocolat", price: 1, category: "snack", location: "fridge", displayStock: 15, reserveStock: 20 },
    { id: randomUUID(), name: "Pizza", price: 3.5, category: "frozen", location: "freezer", displayStock: 6, reserveStock: 6 },
    { id: randomUUID(), name: "Glace", price: 1.5, category: "frozen", location: "freezer", displayStock: 8, reserveStock: 8 },
  ],
  members: [
    { id: randomUUID(), name: "Alex", group: "chauffeur", balance: 0 },
    { id: randomUUID(), name: "Camille", group: "maintenance", balance: 0 },
    { id: randomUUID(), name: "Sam", group: "roto", balance: 0 },
  ],
  transactions: [],
  inventories: [],
  inventoryDraft: { products: {}, cashCounted: "" },
  lastInventoryAt: null,
};

const staticFiles = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/kiosque", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/gestion", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/inventaire", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
]);

function normalizeState(nextState) {
  const state = {
    ...demoState,
    ...nextState,
    products: Array.isArray(nextState?.products) ? nextState.products : [],
    members: Array.isArray(nextState?.members) ? nextState.members : [],
    transactions: Array.isArray(nextState?.transactions) ? nextState.transactions : [],
    inventories: Array.isArray(nextState?.inventories) ? nextState.inventories : [],
    inventoryDraft: normalizeInventoryDraft(nextState?.inventoryDraft),
    lastInventoryAt: nextState?.lastInventoryAt ?? null,
  };

  state.products = state.products.map((product) => {
    const displayStock = Math.max(0, Number(product.displayStock) || 0);
    const reserveStock = Math.max(0, Number(product.reserveStock) || 0);
    return {
      id: product.id || randomUUID(),
      name: String(product.name || "Produit").trim(),
      price: Number(product.price) || 0,
      image: String(product.image || "").trim(),
      category: ["drink", "snack", "frozen"].includes(product.category) ? product.category : "drink",
      location: ["fridge", "freezer"].includes(product.location) ? product.location : "fridge",
      displayStock,
      reserveStock: product.category === "frozen" ? displayStock : reserveStock,
      inventoryBaseStock: Math.max(0, Number(product.inventoryBaseStock ?? displayStock) || 0),
      restockTarget: Math.max(0, Number(product.restockTarget) || 10),
    };
  });

  state.members = state.members.map((member) => ({
    id: member.id || randomUUID(),
    name: String(member.name || "Équipier").trim(),
    group: memberGroups[member.group] ? member.group : "autre",
    balance: Number(member.balance) || 0,
  }));

  return state;
}

function normalizeInventoryDraft(draft = {}) {
  return {
    products: draft.products && typeof draft.products === "object" ? draft.products : {},
    cashCounted: draft.cashCounted ?? "",
  };
}

async function readState() {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch {
    const state = normalizeState(demoState);
    await writeState(state);
    return state;
  }
}

async function writeState(state) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DATA_FILE, `${JSON.stringify(normalizeState(state), null, 2)}\n`, "utf8");
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        request.destroy();
        reject(new Error("Payload too large"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function broadcastStateChange() {
  const data = JSON.stringify({ type: "state-updated", at: new Date().toISOString() });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

async function handleApi(request, response) {
  if (request.url === "/api/sse") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    response.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    sseClients.add(response);
    request.on("close", () => sseClients.delete(response));
    return;
  }

  if (request.url !== "/api/state") {
    sendJson(response, 404, { error: "Route inconnue" });
    return;
  }

  if (request.method === "GET") {
    sendJson(response, 200, await readState());
    return;
  }

  if (request.method === "PUT") {
    try {
      const body = await readRequestBody(request);
      const state = normalizeState(JSON.parse(body));
      await writeState(state);
      broadcastStateChange();
      sendJson(response, 200, { ok: true });
    } catch {
      sendJson(response, 400, { error: "Données invalides" });
    }
    return;
  }

  sendJson(response, 405, { error: "Méthode non autorisée" });
}

async function handleStatic(request, response) {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname.startsWith("/assets/")) {
    await handleAsset(pathname, response);
    return;
  }
  const target = staticFiles.get(pathname) || { file: "index.html", type: "text/html; charset=utf-8" };

  if (pathname.includes(".")) {
    const knownAsset = staticFiles.get(pathname);
    if (!knownAsset) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Fichier introuvable");
      return;
    }
  }

  const body = await readFile(path.join(ROOT, target.file));
  response.writeHead(200, {
    "Content-Type": target.type,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function assetContentType(filePath, body) {
  if (body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

async function handleAsset(pathname, response) {
  const relativePath = decodeURIComponent(pathname.replace(/^\/assets\//, ""));
  const assetPath = path.resolve(ASSETS_DIR, relativePath);

  if (!assetPath.startsWith(`${ASSETS_DIR}${path.sep}`)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Acces refuse");
    return;
  }

  try {
    const body = await readFile(assetPath);
    response.writeHead(200, {
      "Content-Type": assetContentType(assetPath, body),
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Fichier introuvable");
  }
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.url.startsWith("/api/")) {
      await handleApi(request, response);
      return;
    }
    await handleStatic(request, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "Erreur serveur" });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Le port ${PORT} est deja utilise. Essayez: npm run dev -- ${PORT + 1}`);
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});

function getLanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((network) => network && network.family === "IPv4" && !network.internal)
    .map((network) => `http://${network.address}:${PORT}`);
}

server.listen(PORT, HOST, () => {
  console.log(`Frigo Equipe prêt sur http://localhost:${PORT}`);
  getLanAddresses().forEach((address) => console.log(`Réseau local: ${address}`));
});
