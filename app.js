const STORAGE_KEY = "frigo-equipe-v1";
const API_STATE_URL = "/api/state";
const SSE_URL = "/api/sse";
const SAVE_DEBOUNCE_MS = 150;
let syncPaused = false;
let pendingSync = false;
let saveTimer = null;

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const categories = {
  drink: "Boisson",
  snack: "Friandise",
  frozen: "Surgele",
};

const categoryShort = {
  drink: "BO",
  snack: "FR",
  frozen: "SU",
};

const defaultCategoryPrices = {
  drink: 0.8,
  snack: 0.6,
};

const locations = {
  fridge: "Frigo",
  freezer: "Congelateur",
};

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
    { id: createId(), name: "Coca", price: defaultCategoryPrices.drink, category: "drink", location: "fridge", displayStock: 12, reserveStock: 24, restockTarget: 10 },
    { id: createId(), name: "Eau petillante", price: 0.8, category: "drink", location: "fridge", displayStock: 10, reserveStock: 18, restockTarget: 10 },
    { id: createId(), name: "Barre chocolat", price: defaultCategoryPrices.snack, category: "snack", location: "fridge", displayStock: 15, reserveStock: 20, restockTarget: 10 },
    { id: createId(), name: "Pizza", price: 3.5, category: "frozen", location: "freezer", displayStock: 6, reserveStock: 6, restockTarget: 10 },
    { id: createId(), name: "Glace", price: 1.5, category: "frozen", location: "freezer", displayStock: 8, reserveStock: 8, restockTarget: 10 },
  ],
  members: [
    { id: createId(), name: "Alex", group: "chauffeur", balance: 0 },
    { id: createId(), name: "Camille", group: "maintenance", balance: 0 },
    { id: createId(), name: "Sam", group: "roto", balance: 0 },
  ],
  transactions: [],
  inventories: [],
  inventoryDraft: { products: {}, cashCounted: "", cashRetained: "" },
  cashRetained: 0,
  lastInventoryAt: null,
};

let state = null;
let actionMemberId = null;
let memberSearch = "";
let memberGroupFilter = "all";
let memberLetterFilter = "all";
let memberSort = "az";
let selectedCategory = "all";
let cart = [];
let inventoryCashValues = { cashCounted: "", cashRetained: "" };
let creditOverlayMode = "purchase";

const moneyFormatter = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
});

const dateFormatter = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "short",
  timeStyle: "short",
});

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function activePage() {
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/gestion") return "management";
  if (pathname === "/inventaire") return "inventaire";
  return "kiosk";
}

async function loadState() {
  try {
    const response = await fetch(API_STATE_URL, { headers: { Accept: "application/json" } });
    if (response.ok) {
      return normalizeState(await response.json());
    }
  } catch {}

  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return normalizeState(structuredClone(demoState));

  try {
    const parsed = JSON.parse(raw);
    return normalizeState({
      ...structuredClone(demoState),
      ...parsed,
      products: parsed.products ?? [],
      members: parsed.members ?? [],
      transactions: parsed.transactions ?? [],
      inventories: parsed.inventories ?? [],
    });
  } catch {
    return normalizeState(structuredClone(demoState));
  }
}

function normalizeState(nextState) {
  nextState.products = (nextState.products ?? []).map((product) => {
    const displayStock = Math.max(0, Number(product.displayStock) || 0);
    const base = {
      ...product,
      displayStock,
      reserveStock: Math.max(0, Number(product.reserveStock) || 0),
      inventoryBaseStock: Math.max(0, Number(product.inventoryBaseStock ?? displayStock) || 0),
      restockTarget: Math.max(0, Number(product.restockTarget) || 10),
    };
    if (product.category === "frozen") base.reserveStock = base.displayStock;
    return base;
  });
  nextState.members = (nextState.members ?? []).map((member) => ({
    ...member,
    group: memberGroups[member.group] ? member.group : "autre",
    balance: Number(member.balance) || 0,
  }));
  nextState.inventoryDraft = normalizeInventoryDraft(nextState.inventoryDraft);
  nextState.cashRetained = Math.max(0, Number(nextState.cashRetained) || 0);
  return nextState;
}

function normalizeInventoryDraft(draft = {}) {
  return {
    products: draft.products && typeof draft.products === "object" ? draft.products : {},
    cashCounted: draft.cashCounted ?? "",
    cashRetained: draft.cashRetained ?? "",
  };
}

async function saveState() {
  window.clearTimeout(saveTimer);
  saveTimer = null;
  syncPaused = true;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  try {
    const response = await fetch(API_STATE_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });

    if (!response.ok) throw new Error("Server rejected state");
  } catch {
    // Local storage already contains the latest state as a fallback.
  }
  setTimeout(() => {
    syncPaused = false;
    if (pendingSync) {
      pendingSync = false;
      refreshStateFromServer();
    }
  }, 300);
}

function saveStateSoon() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveState, SAVE_DEBOUNCE_MS);
}

function formatMoney(value) {
  return moneyFormatter.format(Number(value) || 0);
}

function parseMoneyInput(value) {
  const normalized = String(value ?? "")
    .replace(",", ".")
    .replace(/[^0-9.-]/g, "");
  return Number(normalized) || 0;
}

function formInputValue(form, name) {
  return form.querySelector(`[name="${name}"]`)?.value ?? "";
}

function inventoryMoneyValue(form, name) {
  const value = formInputValue(form, name);
  if (value !== "") return value;
  return inventoryCashValues[name] || state.inventoryDraft[name] || "";
}

function syncInventoryDraftFromForm(form) {
  state.inventoryDraft.cashCounted = inventoryMoneyValue(form, "cashCounted");
  state.inventoryDraft.cashRetained = inventoryMoneyValue(form, "cashRetained");
  saveStateSoon();
}

function inventoryDraftMoneyValue(field) {
  return inventoryCashValues[field] || state.inventoryDraft[field] || "";
}

function formatDate(value) {
  return dateFormatter.format(new Date(value));
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function getAvatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash % 360);
  return `linear-gradient(135deg, hsl(${h}, 70%, 55%), hsl(${(h + 40) % 360}, 75%, 45%))`;
}

function toast(message) {
  const toastNode = $("#toast");
  toastNode.textContent = message;
  toastNode.classList.add("show");
  window.clearTimeout(toastNode.hideTimer);
  toastNode.hideTimer = window.setTimeout(() => toastNode.classList.remove("show"), 2600);
}

function currentPeriodTransactions() {
  const since = state.lastInventoryAt ? new Date(state.lastInventoryAt).getTime() : 0;
  return state.transactions.filter((transaction) => new Date(transaction.createdAt).getTime() > since);
}

function periodExpectedCash() {
  return currentPeriodTransactions()
    .reduce((sum, transaction) => {
      if (transaction.type === "sale" && transaction.payment === "cash") return sum + transaction.amount;
      if (transaction.type === "payment") return sum + transaction.amount;
      if (transaction.type === "cash-withdrawal") return sum - transaction.amount;
      return sum;
    }, 0);
}

function currentPeriodCashWithdrawals() {
  return currentPeriodTransactions()
    .filter((transaction) => transaction.type === "cash-withdrawal")
    .reduce((sum, transaction) => sum + transaction.amount, 0);
}

function totalCredit() {
  return state.members.reduce((sum, member) => sum + Math.max(0, member.balance), 0);
}

function totalPrepaid() {
  return state.members.reduce((sum, member) => sum + Math.max(0, -member.balance), 0);
}

function currentPeriodCreditBalance() {
  return currentPeriodTransactions().reduce((sum, transaction) => {
    if (transaction.type === "sale" && transaction.payment === "credit") return sum + transaction.amount;
    if (transaction.type === "payment") return sum - transaction.amount;
    return sum;
  }, 0);
}

function inventoryCreditBalanceLabel() {
  const balance = currentPeriodCreditBalance();
  if (balance > 0) return `Crédit: +${formatMoney(balance)}`;
  if (balance < 0) return `Avoir: -${formatMoney(Math.abs(balance))}`;
  return formatMoney(0);
}

function maintenanceMembers() {
  return state.members.filter((member) => member.group === "maintenance").sort(sortMembers);
}

function memberBalanceLabel(member) {
  if (member.balance > 0) return `Doit ${formatMoney(member.balance)}`;
  if (member.balance < 0) return `Avoir ${formatMoney(Math.abs(member.balance))}`;
  return formatMoney(0);
}

function memberBalanceClass(member) {
  if (member.balance > 0) return "debt";
  if (member.balance < 0) return "prepaid";
  return "neutral";
}

function cartTotal() {
  return cart.reduce((sum, item) => {
    const product = state.products.find((candidate) => candidate.id === item.productId);
    return sum + (product?.price ?? 0) * item.quantity;
  }, 0);
}

function render() {
  if (!state) return;
  applyActivePage();
  renderMode();
  renderMemberControls();
  renderKioskProducts();
  renderCart();
  renderStats();
  renderProductManagement();
  renderMemberManagement();
  renderCashWithdrawalDialog();
  renderRestock();
  renderInventory();
  renderInventoryMobile();
  renderHistory();
  renderMemberActionDialog();
  renderCreditMemberFilters();
  renderCreditMembers();
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function renderStockViews() {
  renderKioskProducts();
  renderStats();
  renderRestock();
  renderInventory();
  renderInventoryMobile();
  if (window.lucide) window.lucide.createIcons();
}

function renderMemberControls() {
  $$('select[name="group"]').forEach((select) => {
    const currentValue = select.value || "autre";
    select.innerHTML = Object.entries(memberGroups)
      .map(([value, label]) => `<option value="${value}">${label}</option>`)
      .join("");
    select.value = memberGroups[currentValue] ? currentValue : "autre";
  });
}

function renderMode() {
}

function applyActivePage() {
  const page = activePage();
  $$(".view").forEach((view) => {
    view.classList.toggle("active-view", view.id === page);
  });
  document.body.dataset.page = page;
}

function renderCreditMemberFilters() {
  const groupContainer = $("#credit-member-group-buttons");
  if (groupContainer) {
    groupContainer.innerHTML = [
      ["all", "Toutes"],
      ...Object.entries(memberGroups),
    ].map(([value, label]) => `
      <button
        class="${memberGroupFilter === value ? "active" : ""}"
        type="button"
        data-member-group="${value}"
        aria-pressed="${memberGroupFilter === value}"
      >
        ${label}
      </button>
    `).join("");
  }

  const letterContainer = $("#credit-member-letter-buttons");
  if (letterContainer) {
    const letters = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index));
    letterContainer.innerHTML = [
      ["all", "Tous"],
      ...letters.map((letter) => [letter, letter]),
    ].map(([value, label]) => `
      <button
        class="${memberLetterFilter === value ? "active" : ""}"
        type="button"
        data-member-letter="${value}"
        aria-pressed="${memberLetterFilter === value}"
      >
        ${label}
      </button>
    `).join("");
  }
}

function renderCreditMembers() {
  const list = $("#credit-member-list");
  list.innerHTML = "";

  if (!state.members.length) {
    list.innerHTML = "<p class='empty-placeholder'>Aucun équipier. Ajoutez-en un depuis le kiosque.</p>";
    return;
  }

  const visibleMembers = state.members
    .filter((member) => memberLetterFilter === "all" || member.name.trim().toLocaleUpperCase("fr-FR").startsWith(memberLetterFilter))
    .filter((member) => memberGroupFilter === "all" || member.group === memberGroupFilter)
    .sort(sortMembers);

  if (!visibleMembers.length) {
    list.innerHTML = "<p class='empty-placeholder'>Aucun équipier trouvé.</p>";
    return;
  }

  visibleMembers.forEach((member) => {
    const card = document.createElement("article");
    card.className = "member-card";
    const hasDebt = member.balance > 0;
    card.classList.toggle("has-debt", hasDebt);
    card.classList.toggle("has-prepaid", member.balance < 0);
    card.dataset.memberId = member.id;
    card.innerHTML = `
      <div class="member-details">
        <div class="member-row">
          <span class="member-name">${member.name}</span>
          <span class="member-balance ${memberBalanceClass(member)}">${memberBalanceLabel(member)}</span>
        </div>
        <span class="member-group-text">${memberGroups[member.group]}</span>
      </div>
    `;
    list.append(card);
  });
}

function openCreditMemberSelection() {
  creditOverlayMode = "purchase";
  const header = document.querySelector(".kiosk-credit-header h3");
  if (header) header.textContent = "Choisir un équipier";
  const layout = document.querySelector(".kiosk-layout");
  if (layout) layout.classList.add("hidden");
  const overlay = $("#kiosk-credit-members");
  overlay.classList.remove("hidden");
  renderCreditMemberFilters();
  renderCreditMembers();
  if (window.lucide) window.lucide.createIcons();
}

function openCreditAccountSelection() {
  creditOverlayMode = "credit-account";
  const header = document.querySelector(".kiosk-credit-header h3");
  if (header) header.textContent = "Créditer un compte";
  const layout = document.querySelector(".kiosk-layout");
  if (layout) layout.classList.add("hidden");
  const overlay = $("#kiosk-credit-members");
  overlay.classList.remove("hidden");
  renderCreditMemberFilters();
  renderCreditMembers();
  if (window.lucide) window.lucide.createIcons();
}

function closeCreditMemberSelection() {
  const overlay = $("#kiosk-credit-members");
  overlay.classList.add("hidden");
  const layout = document.querySelector(".kiosk-layout");
  if (layout) layout.classList.remove("hidden");
}

function startCreditPurchase(memberId) {
  closeCreditMemberSelection();
  checkout("credit", memberId);
}

function sortMembers(a, b) {
  if (memberSort === "za") return b.name.localeCompare(a.name, "fr");
  if (memberSort === "credit-desc") return b.balance - a.balance || a.name.localeCompare(b.name, "fr");
  if (memberSort === "credit-asc") return a.balance - b.balance || a.name.localeCompare(b.name, "fr");
  return a.name.localeCompare(b.name, "fr");
}

function openMemberCreditDialog(memberId) {
  actionMemberId = memberId;
  renderMemberActionDialog();
  $("#member-action-dialog").classList.add("credit-only-dialog");
  $("#member-credit-form").reset();
  clearQuickCreditSelection();
  $("#member-credit-form").classList.remove("hidden");
  $("#member-action-dialog").showModal();
}

function renderMemberActionDialog() {
  const member = state.members.find((candidate) => candidate.id === actionMemberId);
  if (!member) return;

  $("#member-dialog-name").textContent = member.name;
  $("#member-dialog-balance").textContent = `Solde actuel: ${memberBalanceLabel(member)}`;
}

function renderKioskProducts() {
  const grid = $("#kiosk-products");
  grid.innerHTML = "";

  const products = state.products
    .filter((product) => selectedCategory === "all" || product.category === selectedCategory)
    .sort((a, b) => a.location.localeCompare(b.location) || a.name.localeCompare(b.name));

  if (!products.length) {
    grid.innerHTML = "<p class='empty-placeholder'>Aucun produit dans cette catégorie.</p>";
    return;
  }

  const categoryIcons = {
    drink: "cup-soda",
    snack: "cookie",
    frozen: "snowflake",
  };
  const visualIcons = {
    drink: "cup-soda",
    snack: "candy",
    frozen: "snowflake",
  };
  const locationIcons = {
    fridge: "thermometer",
    freezer: "snowflake",
  };

  products.forEach((product) => {
    const button = document.createElement("button");
    button.className = "product-card";
    button.dataset.category = product.category;
    button.dataset.location = product.location;
    button.disabled = product.displayStock <= 0;
    button.innerHTML = `
      <div class="product-visual category-${product.category}">
        <i data-lucide="${visualIcons[product.category]}"></i>
      </div>
      <div class="product-card-header">
        <span class="product-badge category-${product.category}">
          <i data-lucide="${categoryIcons[product.category]}"></i>
          <span>${categories[product.category]}</span>
        </span>
        <span class="stock-badge ${product.displayStock <= 2 ? 'low-stock' : ''}">
          ${product.displayStock} dispo
        </span>
      </div>
      <div class="product-card-body">
        <strong>${product.name}</strong>
        <div class="product-location">
          <i data-lucide="${locationIcons[product.location]}"></i>
          <span>${locations[product.location]}</span>
        </div>
      </div>
      <div class="product-card-footer">
        <span class="product-price">${formatMoney(product.price)}</span>
        <span class="add-indicator"><i data-lucide="plus"></i></span>
      </div>
    `;
    button.addEventListener("click", () => addToCart(product.id));
    grid.append(button);
  });
}

function addToCart(productId) {
  const product = state.products.find((candidate) => candidate.id === productId);
  const existing = cart.find((item) => item.productId === productId);
  const currentQuantity = existing?.quantity ?? 0;

  if (!product || currentQuantity >= product.displayStock) {
    toast("Stock insuffisant pour ce produit.");
    return;
  }

  if (existing) existing.quantity += 1;
  else cart.push({ productId, quantity: 1 });
  renderCart();
  hideCashChangePanel();
}

function renderCart() {
  const container = $("#cart-items");
  container.innerHTML = "";
  container.classList.toggle("empty", cart.length === 0);

  if (!cart.length) {
    container.innerHTML = `
      <div class="cart-empty-state">
        <i data-lucide="shopping-bag"></i>
        <span>Aucun produit sélectionné</span>
      </div>
    `;
  } else {
    cart.forEach((item) => {
      const product = state.products.find((candidate) => candidate.id === item.productId);
      const line = document.createElement("div");
      line.className = "cart-line";
      line.innerHTML = `
        <span class="cart-product-thumb category-${product.category}">
          <i data-lucide="${product.category === "drink" ? "cup-soda" : product.category === "snack" ? "candy" : "snowflake"}"></i>
        </span>
        <div class="cart-item-info">
          <strong class="cart-item-name">${product.name}</strong>
          <div class="cart-item-meta">
            <span class="cart-item-qty">${item.quantity} x</span>
            <span class="cart-item-price">${formatMoney(product.price)}</span>
          </div>
        </div>
        <div class="cart-item-actions">
          <span class="cart-item-subtotal">${formatMoney(product.price * item.quantity)}</span>
          <button class="icon-button remove-btn" aria-label="Retirer ${product.name}">
            <i data-lucide="minus"></i>
          </button>
        </div>
      `;
      line.querySelector("button").addEventListener("click", () => {
        item.quantity -= 1;
        cart = cart.filter((candidate) => candidate.quantity > 0);
        renderCart();
        if (!cart.length) hideCashChangePanel();
      });
      container.append(line);
    });
  }

  $("#cart-total").textContent = formatMoney(cartTotal());
  updateCashChange();
}

function showCashChangePanel() {
  if (!cart.length) {
    toast("Ajoutez au moins un produit.");
    return;
  }

  const dialog = $("#cash-dialog");
  $("#cash-dialog-total").textContent = formatMoney(cartTotal());
  $("#cash-received").value = "";
  updateCashChange();
  dialog.showModal();
}

function hideCashChangePanel() {
  const dialog = $("#cash-dialog");
  if (!dialog) return;
  dialog.close();
  $("#cash-received").value = "";
  $("#cash-change").textContent = formatMoney(0);
}

function updateCashChange() {
  const receivedInput = $("#cash-received");
  const changeNode = $("#cash-change");
  const confirmButton = $("#confirm-cash-checkout");
  if (!receivedInput || !changeNode || !confirmButton) return;

  const received = Number(receivedInput.value) || 0;
  const total = cartTotal();
  const change = received - total;
  changeNode.textContent = formatMoney(Math.max(0, change));
  changeNode.classList.toggle("danger", change < 0);
  confirmButton.disabled = !cart.length || change < 0;
}

function applyCashPreset(event) {
  const button = event.target.closest("[data-cash-preset]");
  if (!button) return;
  $("#cash-received").value = Number(button.dataset.cashPreset).toFixed(2);
  updateCashChange();
}

function checkout(payment, memberId = null) {
  if (!cart.length) {
    toast("Ajoutez au moins un produit.");
    return;
  }

  if (payment === "credit" && !memberId) {
    toast("Sélectionnez un équipier.");
    return;
  }

  const member = memberId ? state.members.find((candidate) => candidate.id === memberId) : null;

  const lines = cart.map((item) => {
    const product = state.products.find((candidate) => candidate.id === item.productId);
    return {
      productId: item.productId,
      name: product.name,
      unitPrice: product.price,
      quantity: item.quantity,
      location: product.location,
    };
  });

  for (const item of cart) {
    const product = state.products.find((candidate) => candidate.id === item.productId);
    product.displayStock -= item.quantity;
    if (product.category === "frozen") product.reserveStock = product.displayStock;
  }
  clearInventoryDraftProducts(cart.map((item) => item.productId));

  const amount = cartTotal();
  if (payment === "credit" && member) {
    member.balance += amount;
  }

  state.transactions.unshift({
    id: createId(),
    type: "sale",
    payment,
    memberId: member ? member.id : null,
    memberName: member ? member.name : "Espèces",
    amount,
    lines,
    createdAt: new Date().toISOString(),
  });

  cart = [];
  hideCashChangePanel();
  saveState();
  render();
  toast(payment === "cash" ? "Vente en especes enregistree." : "Vente ajoutee au credit.");
}

function recordPayment(memberId, amount) {
  const member = state.members.find((candidate) => candidate.id === memberId);
  if (!member || amount <= 0) return false;

  member.balance -= amount;
  state.transactions.unshift({
    id: createId(),
    type: "payment",
    memberId: member.id,
    memberName: member.name,
    amount,
    createdAt: new Date().toISOString(),
  });
  saveState();
  return true;
}

function renderStats() {
  const credit = totalCredit();
  const prepaid = totalPrepaid();
  const stockValue = state.products.reduce((sum, product) => sum + (product.category === "frozen" ? product.displayStock : product.displayStock + product.reserveStock) * product.price, 0);
  const lowProducts = state.products.filter((product) => product.displayStock <= 2);

  const statsData = [
    {
      icon: "credit-card",
      class: "stat-credit",
      content: `
        <span class="stat-label">Ardoise</span>
        <span class="stat-diff" style="color: ${prepaid >= credit ? "#10b981" : "#e5485d"}">${prepaid >= credit ? "+" : "-"}${formatMoney(Math.abs(prepaid - credit))}</span>
      `
    },
    { label: "Valeur du stock", value: formatMoney(stockValue), icon: "package", class: "stat-stock" },
    { label: "Alertes stock", value: String(lowProducts.length), icon: "alert-triangle", class: lowProducts.length > 0 ? "stat-alert danger" : "stat-alert", items: lowProducts }
  ];

  $("#stats").innerHTML = statsData.map(stat => `
    <article class="stat-card ${stat.class}">
      <div class="stat-icon-wrapper">
        <i data-lucide="${stat.icon}"></i>
      </div>
      <div class="stat-details">
        ${stat.content || `
          <span class="stat-label">${stat.label}</span>
          <strong>${stat.value}</strong>
        `}
        ${stat.items ? `<div class="stat-items">${stat.items.map(p => `<span class="stat-item">${p.name} (${p.displayStock})</span>`).join("")}</div>` : ""}
      </div>
    </article>
  `).join("");
}

function renderProductManagement() {
  const list = $("#product-list");
  list.innerHTML = "";

  if (!state.products.length) {
    list.innerHTML = `
      <div class="empty-list-placeholder">
        <i data-lucide="package-x"></i>
        <p>Aucun produit enregistré.</p>
      </div>
    `;
    return;
  }

  const categoryOrder = ["drink", "snack", "frozen"];
  list.classList.add("stock-columns");

  categoryOrder.forEach((category) => {
    const column = document.createElement("section");
    column.className = "stock-category-column";
    column.innerHTML = `
      <h4>${categories[category]}</h4>
      <div class="stock-category-items"></div>
    `;
    const items = column.querySelector(".stock-category-items");
    const products = state.products
      .filter((product) => product.category === category)
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));

    if (!products.length) {
      items.innerHTML = "<p class='empty-placeholder'>Aucun article.</p>";
      list.append(column);
      return;
    }

    products.forEach((product) => {
      const missing = Math.max(0, product.restockTarget - product.displayStock);
      const row = document.createElement("div");
      row.className = "table-row product-manage-row";
      row.innerHTML = `
      <div class="product-name-cell">
        <strong>${product.name}</strong>
        <span class="pill-category category-${product.category}">${categories[product.category]}</span>
      </div>
      <div class="manage-stock-fields">
        ${product.category === "frozen"
          ? `<div class="stock-inline-field stock-single">
              <i data-lucide="snowflake"></i>
              <span>Stock</span>
              <input class="stock-edit-input stock-edit-frozen" data-product-id="${product.id}" type="number" min="0" step="1" value="${product.displayStock}" inputmode="numeric" />
             </div>`
          : `<label class="stock-inline-field">
              <i data-lucide="archive"></i>
              <span>Stock principal</span>
              <input class="stock-edit-input" data-product-id="${product.id}" type="number" min="0" step="1" value="${product.reserveStock}" inputmode="numeric" />
             </label>`
        }
        <div class="restock-target-field">
          <i data-lucide="crosshair"></i>
          <span>Cible</span>
          <input class="target-edit-input" data-product-id="${product.id}" type="number" min="0" step="1" value="${product.restockTarget}" inputmode="numeric" />
        </div>
      </div>
      <div class="row-actions">
        <button class="product-edit-button" data-action="edit" type="button" title="Modifier ${escapeAttribute(product.name)}" aria-label="Modifier ${escapeAttribute(product.name)}">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M12 20h9"></path>
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
          </svg>
        </button>
        <button class="product-delete-button" data-action="delete" type="button" title="Supprimer ${escapeAttribute(product.name)}" aria-label="Supprimer ${escapeAttribute(product.name)}">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M3 6h18"></path>
            <path d="M8 6V4h8v2"></path>
            <path d="M19 6l-1 14H6L5 6"></path>
            <path d="M10 11v6"></path>
            <path d="M14 11v6"></path>
          </svg>
        </button>
      </div>
    `;
      const stockInput = row.querySelector(".stock-edit-input");
      stockInput.addEventListener("focus", handleStockFieldFocus);
      stockInput.addEventListener("keydown", handleStockFieldKeyboard);
      stockInput.addEventListener("change", updateProductStockField);
      stockInput.addEventListener("blur", updateProductStockField);
      const targetInput = row.querySelector(".target-edit-input");
      if (targetInput) {
        targetInput.addEventListener("focus", handleStockFieldFocus);
        targetInput.addEventListener("change", updateProductRestockTarget);
        targetInput.addEventListener("blur", updateProductRestockTarget);
      }
      row.querySelector('[data-action="edit"]').addEventListener("click", () => editProduct(product.id));
      row.querySelector('[data-action="delete"]').addEventListener("click", () => deleteProduct(product.id));
      items.append(row);
    });

    list.append(column);
  });
}

function handleStockFieldFocus(event) {
  if (event.currentTarget.select) event.currentTarget.select();
}

function handleStockFieldKeyboard(event) {
  const inputs = $$(".stock-edit-input");
  const currentIndex = inputs.indexOf(event.currentTarget);
  let nextIndex = null;

  if (event.key === "ArrowDown" || event.key === "Enter") nextIndex = currentIndex + 1;
  if (event.key === "ArrowUp") nextIndex = currentIndex - 1;

  if (nextIndex === null) return;
  event.preventDefault();
  updateProductStockField(event);
  const next = inputs[Math.max(0, Math.min(nextIndex, inputs.length - 1))];
  next?.focus();
  if (next?.select) next.select();
}

function updateProductStockField(event) {
  const input = event.currentTarget;
  const product = state.products.find((candidate) => candidate.id === input.dataset.productId);
  if (!product) return;

  const value = Math.max(0, Math.floor(Number(input.value) || 0));
  input.value = value;
  if (product.category === "frozen") {
    if (product.displayStock === value) return;
    product.displayStock = value;
    product.reserveStock = value;
  } else {
    if (product.reserveStock === value) return;
    product.reserveStock = value;
  }
  clearInventoryDraftProducts([product.id]);
  saveStateSoon();
  renderStockViews();
}

function updateProductRestockTarget(event) {
  const input = event.currentTarget;
  const product = state.products.find((candidate) => candidate.id === input.dataset.productId);
  if (!product) return;

  const value = Math.max(0, Math.floor(Number(input.value) || 10));
  input.value = value;
  if (product.restockTarget === value) return;
  product.restockTarget = value;
  saveStateSoon();
  renderStockViews();
}

function editProduct(id) {
  const product = state.products.find((candidate) => candidate.id === id);
  const form = $("#product-form");
  $("#product-dialog-title").textContent = "Modifier le produit";
  for (const [key, value] of Object.entries(product)) {
    if (form.elements[key]) form.elements[key].value = value;
  }
  if (product.category === "frozen") {
    form.elements.reserveStock.disabled = true;
  } else {
    form.elements.reserveStock.disabled = false;
  }
  $("#product-dialog").showModal();
  form.elements.name.focus();
}

function openProductForm() {
  const form = $("#product-form");
  form.reset();
  form.elements.id.value = "";
  form.elements.price.value = defaultCategoryPrices[form.elements.category.value] ?? "";
  form.elements.reserveStock.disabled = false;
  $("#product-dialog-title").textContent = "Ajouter au stock";
  $("#product-dialog").showModal();
  form.elements.name.focus();
}

function applyDefaultProductPrice() {
  const form = $("#product-form");
  if (form.elements.id.value) return;
  const defaultPrice = defaultCategoryPrices[form.elements.category.value];
  if (defaultPrice === undefined) return;
  form.elements.price.value = defaultPrice.toFixed(2);
}

function deleteProduct(id) {
  const product = state.products.find((candidate) => candidate.id === id);
  if (!product || !confirm(`Supprimer ${product.name} ?`)) return;
  state.products = state.products.filter((candidate) => candidate.id !== id);
  cart = cart.filter((item) => item.productId !== id);
  clearInventoryDraftProducts([id]);
  saveState();
  render();
}

function renderMemberManagement() {
  const list = $("#member-list");
  list.innerHTML = "";

  if (!state.members.length) {
    list.innerHTML = `
      <div class="empty-list-placeholder">
        <i data-lucide="users-round"></i>
        <p>Aucun équipier enregistré.</p>
      </div>
    `;
    return;
  }

  state.members.forEach((member) => {
    const card = document.createElement("article");
    card.className = "member-card member-manage-card";
    card.classList.toggle("has-debt", member.balance > 0);
    card.classList.toggle("has-prepaid", member.balance < 0);
    card.innerHTML = `
      <div class="member-manage-top">
        <div class="member-details">
          <div class="member-manage-title">
            <strong>${member.name}</strong>
            <div class="member-manage-tools">
              <button class="member-edit-button" type="button" title="Modifier ${member.name}" aria-label="Modifier ${member.name}">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M12 20h9"></path>
                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
                </svg>
              </button>
              <button class="member-delete-button" type="button" title="Supprimer ${member.name}" aria-label="Supprimer ${member.name}">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M3 6h18"></path>
                  <path d="M8 6V4h8v2"></path>
                  <path d="M19 6l-1 14H6L5 6"></path>
                  <path d="M10 11v6"></path>
                  <path d="M14 11v6"></path>
                </svg>
              </button>
            </div>
          </div>
          <span class="member-group-text">${memberGroups[member.group]}</span>
        </div>
      </div>
      <div class="member-manage-balance">
        <i data-lucide="credit-card"></i>
        <span class="member-balance ${memberBalanceClass(member)}">${memberBalanceLabel(member)}</span>
      </div>
    `;
    card.querySelector(".member-edit-button").addEventListener("click", () => editMember(member.id));
    card.querySelector(".member-delete-button").addEventListener("click", () => {
      if (!confirm(`Supprimer ${member.name} ?`)) return;
      state.members = state.members.filter((candidate) => candidate.id !== member.id);
      if (actionMemberId === member.id) actionMemberId = null;
      saveState();
      render();
    });
    list.append(card);
  });
}

function editMember(id) {
  const member = state.members.find((candidate) => candidate.id === id);
  if (!member) return;

  const form = $("#member-edit-form");
  form.elements.id.value = member.id;
  form.elements.name.value = member.name;
  form.elements.group.value = memberGroups[member.group] ? member.group : "autre";
  $("#member-edit-dialog").showModal();
  form.elements.name.focus();
}

function submitMemberEdit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const member = state.members.find((candidate) => candidate.id === form.elements.id.value);
  if (!member) return;

  const name = form.elements.name.value.trim();
  if (!name) return;

  member.name = name;
  member.group = memberGroups[form.elements.group.value] ? form.elements.group.value : "autre";
  state.transactions.forEach((transaction) => {
    if (transaction.memberId === member.id) transaction.memberName = member.name;
  });
  saveState();
  form.reset();
  $("#member-edit-dialog").close();
  render();
  toast("Équipier modifié.");
}

function renderRestock() {
  const list = $("#restock-list");
  list.innerHTML = "";

  if (!state.products.length) {
    list.innerHTML = `
      <div class="empty-list-placeholder">
        <i data-lucide="package-x"></i>
        <p>Aucun produit enregistré.</p>
      </div>
    `;
    return;
  }

  const categoryOrder = ["drink", "snack", "frozen"];
  list.classList.add("stock-columns");

  categoryOrder.forEach((category) => {
    const column = document.createElement("section");
    column.className = "stock-category-column";
    column.innerHTML = `
      <h4>${categories[category]}</h4>
      <div class="stock-category-items"></div>
    `;
    const items = column.querySelector(".stock-category-items");
    const products = state.products
      .filter((product) => product.category === category)
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));

    if (!products.length) {
      items.innerHTML = "<p class='empty-placeholder'>Aucun article.</p>";
      list.append(column);
      return;
    }

    products.forEach((product) => {
      const missing = Math.max(0, product.restockTarget - product.displayStock);
      const row = document.createElement("div");
      row.className = `table-row restock-row ${missing > 0 ? "needs-restock" : ""}`;
      row.dataset.productId = product.id;
      if (product.category === "frozen") {
        row.innerHTML = `
          <div class="row-info">
            <div class="row-title">
              <strong>${product.name}</strong>
              <span class="pill-category category-${product.category}">${categories[product.category]}</span>
            </div>
            <div class="row-meta">
              <span class="${product.displayStock <= 2 ? "danger" : ""}">
                <i data-lucide="snowflake"></i>
                Stock: <strong>${product.displayStock}</strong>
              </span>
              <span>
                <i data-lucide="crosshair"></i>
                Cible: <strong>${product.restockTarget}</strong>
              </span>
              <span class="${missing > 0 ? "danger" : "success"}">
                <i data-lucide="${missing > 0 ? "arrow-down" : "check"}"></i>
                Manque: <strong>${missing}</strong>
              </span>
            </div>
          </div>
          <label class="restock-transfer-field">
            <span>Ajouter au stock</span>
            <input class="restock-quantity restock-frozen-quantity" type="number" min="0" step="1" inputmode="numeric" data-product-id="${product.id}" />
          </label>
        `;
      } else {
        row.innerHTML = `
          <div class="row-info">
            <div class="row-title">
              <strong>${product.name}</strong>
              <span class="pill-category category-${product.category}">${categories[product.category]}</span>
            </div>
            <div class="row-meta">
              <span class="${product.displayStock <= 2 ? "danger" : ""}">
                <i data-lucide="refrigerator"></i>
                Frigo: <strong>${product.displayStock}</strong>
              </span>
              <span>
                <i data-lucide="archive"></i>
                Réserve: <strong>${product.reserveStock}</strong>
              </span>
              <span>
                <i data-lucide="crosshair"></i>
                Cible: <strong>${product.restockTarget}</strong>
              </span>
              <span class="${missing > 0 ? "danger" : "success"}">
                <i data-lucide="${missing > 0 ? "arrow-down" : "check"}"></i>
                Manque: <strong>${missing}</strong>
              </span>
            </div>
          </div>
          <label class="restock-transfer-field">
            <span>Remis dans le frigo</span>
            <input class="restock-quantity" type="number" min="0" max="${product.reserveStock}" step="1" inputmode="numeric" data-product-id="${product.id}" ${product.reserveStock <= 0 ? "disabled" : ""} />
          </label>
        `;
      }
      const input = row.querySelector(".restock-quantity");
      if (input) {
        input.addEventListener("focus", (event) => event.currentTarget.select());
        input.addEventListener("change", () => {
          if (product.category === "frozen") restockFrozenProductFromRow(product.id);
          else restockProductFromRow(product.id);
        });
        input.addEventListener("keydown", handleRestockKeyboard);
      }
      items.append(row);
    });

    list.append(column);
  });
}

function inventoryStock(product) {
  return product.inventoryBaseStock ?? product.displayStock;
}

function inventoryDraftValue(product) {
  return state.inventoryDraft.products[product.id] ?? product.displayStock;
}

function inventorySalesValue(form) {
  return state.products.reduce((sum, product) => {
    const previousStock = inventoryStock(product);
    const countedStock = Number(form.elements[`product-${product.id}`]?.value || previousStock);
    return sum + Math.max(0, previousStock - countedStock) * product.price;
  }, 0);
}

function inventoryOpeningCash() {
  return Math.max(0, Number(state.cashRetained) || 0);
}

function inventorySettlementTotal(cashCounted) {
  return Number(cashCounted) - inventoryOpeningCash() + currentPeriodCashWithdrawals() + currentPeriodCreditBalance();
}

function inventoryBalance(form) {
  const salesValue = inventorySalesValue(form);
  const cashCounted = parseMoneyInput(inventoryMoneyValue(form, "cashCounted"));
  const settlementTotal = inventorySettlementTotal(cashCounted);
  return {
    salesValue,
    cashCounted,
    openingCash: inventoryOpeningCash(),
    withdrawn: currentPeriodCashWithdrawals(),
    creditBalance: currentPeriodCreditBalance(),
    settlementTotal,
    variance: settlementTotal - salesValue,
  };
}

function validateCashRetained(form) {
  const input = form.querySelector('[name="cashRetained"]');
  const cashRetained = parseMoneyInput(inventoryMoneyValue(form, "cashRetained"));
  if (cashRetained > 0) return true;
  toast("Indiquez le montant remis dans la caisse frigo.");
  input?.focus();
  input?.select();
  return false;
}

function focusMoneyInput(event) {
  const input = event.currentTarget;
  if (input.value === "0") input.value = "";
  input.select();
}

function rememberMoneyInput(event) {
  const input = event.currentTarget;
  if (input.name === "cashCounted" || input.name === "cashRetained") {
    inventoryCashValues[input.name] = input.value;
    state.inventoryDraft[input.name] = input.value;
  }
}

function rememberMoneyInputSoon(event) {
  const input = event.currentTarget;
  window.setTimeout(() => rememberMoneyInput({ currentTarget: input }), 0);
}

function confirmInventoryClose() {
  return window.confirm("Clôturer l'inventaire ? Cette action va enregistrer les stocks comptés et démarrer une nouvelle période.");
}

function setInventoryDraftValue(productId, value) {
  state.inventoryDraft.products[productId] = value;
  saveStateSoon();
}

function setInventoryDraftField(field, value) {
  state.inventoryDraft[field] = value;
  saveStateSoon();
}

function clearInventoryDraft() {
  state.inventoryDraft = { products: {}, cashCounted: "", cashRetained: "" };
}

function clearInventoryDraftProducts(productIds) {
  productIds.forEach((productId) => {
    delete state.inventoryDraft.products[productId];
  });
}

function updateInventorySummary() {
  const balance = inventoryBalance($("#inventory-form"));
  const varianceText = balance.variance >= 0 ? `+${formatMoney(balance.variance)}` : formatMoney(balance.variance);
  $("#inventory-summary").innerHTML = `
    <strong>Ventes attendues: ${formatMoney(balance.salesValue)}</strong><br>
    Fond caisse départ: <strong>${formatMoney(balance.openingCash)}</strong>
    <br>
    Caisse frigo: <strong>${formatMoney(balance.cashCounted)}</strong>
    <br>Retrait caisse: <strong>${formatMoney(balance.withdrawn)}</strong>
    <br>Crédit / avoir: <strong>${inventoryCreditBalanceLabel()}</strong>
    <br>Écart inventaire: <strong class="${balance.variance < 0 ? "danger" : "success"}">${varianceText}</strong>
  `;
}

function renderInventory() {
  const productFields = $("#inventory-products");
  const form = $("#inventory-form");
  if (form) {
    form.elements.cashCounted.value = inventoryDraftMoneyValue("cashCounted");
    form.elements.cashRetained.value = inventoryDraftMoneyValue("cashRetained");
  }
  productFields.innerHTML = "";
  productFields.classList.add("table-list", "stock-columns");

  const categoryOrder = ["drink", "snack", "frozen"];

  categoryOrder.forEach((category) => {
    const column = document.createElement("section");
    column.className = "stock-category-column";
    column.innerHTML = `
      <h4>${categories[category]}</h4>
      <div class="stock-category-items"></div>
    `;
    const items = column.querySelector(".stock-category-items");
    const products = state.products
      .filter((product) => product.category === category)
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));

    if (!products.length) {
      items.innerHTML = "<p class='empty-placeholder'>Aucun article.</p>";
      productFields.append(column);
      return;
    }

    products.forEach((product) => {
      const currentStock = inventoryStock(product);
      const row = document.createElement("div");
      row.className = "table-row inventory-row";
      row.innerHTML = `
        <div class="row-info">
          <div class="row-title">
            <strong>${product.name}</strong>
            <span class="pill-category category-${product.category}">${categories[product.category]}</span>
          </div>
          <div class="row-meta">
            <span>${locations[product.location]}</span>
            <span>
              Ancien: <strong>${currentStock}</strong>
            </span>
          </div>
        </div>
        <label class="inventory-count-field">
          <span>Compté</span>
          <input name="product-${product.id}" type="number" min="0" step="1" value="${inventoryDraftValue(product)}" />
        </label>
      `;
      const invInput = row.querySelector("input");
      invInput.addEventListener("focus", (event) => event.currentTarget.select());
      invInput.addEventListener("input", (event) => {
        setInventoryDraftValue(product.id, event.currentTarget.value);
        updateInventorySummary();
      });
      invInput.addEventListener("keydown", handleInventoryKeyboard);
      items.append(row);
    });

    productFields.append(column);
  });

  updateInventorySummary();
}

function renderHistory() {
  const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const history = [...state.transactions, ...state.inventories.map((inventory) => ({ ...inventory, type: "inventory" }))]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .filter((entry) => new Date(entry.createdAt).getTime() > twoWeeksAgo)
    .slice(0, 18);

  if (!history.length) {
    $("#history-list").innerHTML = `
      <div class="empty-list-placeholder">
        <i data-lucide="history"></i>
        <p>Aucun mouvement enregistré pour le moment.</p>
      </div>
    `;
    return;
  }

  $("#history-list").innerHTML = history.map((item) => {
    let icon = "circle";
    let iconClass = "default";
    let title = "";
    let sub = "";
    let badgeText = "";
    let badgeClass = "neutral";

    if (item.type === "inventory") {
      icon = "clipboard-check";
      iconClass = "history-icon-inventory";
      title = "Inventaire clôturé";
      const variance = item.cashVariance;
      const varianceText = variance >= 0 ? `+${formatMoney(variance)}` : formatMoney(variance);
      sub = `Écart inventaire: <strong class="${variance < 0 ? 'danger' : 'success'}">${varianceText}</strong>`;
      badgeText = formatMoney(item.cashCounted);
      badgeClass = "badge-inventory";
    } else if (item.type === "restock") {
      icon = "package-plus";
      iconClass = "history-icon-restock";
      title = `Remplissage : ${item.productName}`;
      sub = "Transféré de la réserve au rayon";
      badgeText = `+${item.quantity}`;
      badgeClass = "badge-restock";
    } else if (item.type === "payment") {
      icon = "arrow-down-to-dot";
      iconClass = "history-icon-payment";
      title = `Compte crédité : ${item.memberName}`;
      sub = "Argent ajouté sur le compte";
      badgeText = `-${formatMoney(item.amount)}`;
      badgeClass = "badge-payment";
    } else if (item.type === "cash-withdrawal") {
      icon = "wallet";
      iconClass = "history-icon-withdrawal";
      title = `Retrait caisse : ${item.memberName}`;
      sub = "Argent retiré du frigo et mis de côté";
      badgeText = `-${formatMoney(item.amount)}`;
      badgeClass = "badge-withdrawal";
    } else { // sale
      const isCash = item.payment === "cash";
      icon = isCash ? "banknote" : "credit-card";
      iconClass = isCash ? "history-icon-cash" : "history-icon-credit";
      title = `${item.memberName}`;
      const itemsList = item.lines ? item.lines.map(l => `${l.quantity}x ${l.name}`).join(", ") : "Produits";
      sub = `<span class="history-item-details" title="${itemsList}">${itemsList}</span>`;
      badgeText = formatMoney(item.amount);
      badgeClass = isCash ? "badge-cash" : "badge-credit";
    }

    const undoButton = item.type === "payment"
      ? `
        <button class="history-action-button" data-cancel-payment="${item.id}" title="Annuler ce crédit de compte">
          <i data-lucide="undo-2"></i>
          <span>Annuler</span>
        </button>
      `
      : "";

    return `
      <div class="history-item">
        <div class="history-timeline-icon ${iconClass}">
          <i data-lucide="${icon}"></i>
        </div>
        <div class="history-item-body">
          <div class="history-item-main">
            <strong>${title}</strong>
            <div class="history-item-side">
              <span class="history-item-badge ${badgeClass}">${badgeText}</span>
              ${undoButton}
            </div>
          </div>
          <div class="history-item-sub">
            <span class="history-sub-text">${sub}</span>
            <time class="history-time"><i data-lucide="clock"></i> ${formatDate(item.createdAt)}</time>
          </div>
        </div>
      </div>
    `;
  }).join("");

  $$("[data-cancel-payment]").forEach((button) => {
    button.addEventListener("click", () => cancelPayment(button.dataset.cancelPayment));
  });
}

function cancelPayment(transactionId) {
  const payment = state.transactions.find((transaction) => transaction.id === transactionId && transaction.type === "payment");
  if (!payment) {
    toast("Mouvement introuvable.");
    return;
  }

  const member = state.members.find((candidate) => candidate.id === payment.memberId);
  if (member) {
    member.balance += payment.amount;
  }

  state.transactions = state.transactions.filter((transaction) => transaction.id !== transactionId);
  saveState();
  render();
  toast("Crédit de compte annulé.");
}

function submitProduct(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const productId = data.id || createId();
  const existingIndex = state.products.findIndex((candidate) => candidate.id === productId);

  if (existingIndex >= 0) {
    const existing = state.products[existingIndex];
    existing.name = data.name.trim();
    existing.price = Number(data.price);
    existing.category = data.category;
    existing.location = data.location;
    existing.reserveStock = Number(data.category === "frozen" ? existing.displayStock : data.reserveStock);
    existing.restockTarget = Math.max(0, Number(data.restockTarget) || 10);
  } else {
    const displayStock = 0;
    const product = {
      id: productId,
      name: data.name.trim(),
      price: Number(data.price),
      category: data.category,
      location: data.location,
      displayStock,
      reserveStock: Number(data.category === "frozen" ? displayStock : data.reserveStock),
      restockTarget: Math.max(0, Number(data.restockTarget) || 10),
      inventoryBaseStock: displayStock,
    };
    state.products.push(product);
  }
  clearInventoryDraftProducts([productId]);

  event.currentTarget.reset();
  event.currentTarget.elements.id.value = "";
  saveState();
  $("#product-dialog").close();
  render();
  toast("Produit enregistre.");
}

function submitMember(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const name = data.name.trim();
  if (!name) return;
  const member = { id: createId(), name, group: data.group || "autre", balance: 0 };
  state.members.push(member);
  event.currentTarget.reset();
  saveState();
  render();
}

function addMemberFromKiosk(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const name = data.name.trim();
  if (!name) return;

  const existing = state.members.find((member) => member.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    openMemberCreditDialog(existing.id);
    return;
  }

  const member = { id: createId(), name, group: data.group || "autre", balance: 0 };
  state.members.push(member);
  actionMemberId = null;
  event.currentTarget.reset();
  saveState();
  render();
  toast(`${member.name} ajouté.`);
}

function restockProductFromRow(productId, options = {}) {
  const product = state.products.find((candidate) => candidate.id === productId);
  const input = $(`.restock-quantity[data-product-id="${productId}"]`);
  const quantity = Number(input?.value);

  if (!product || quantity <= 0) return;
  if (quantity > product.reserveStock) {
    toast("Quantite superieure a la reserve.");
    input?.focus();
    return;
  }

  product.reserveStock -= quantity;
  product.displayStock += quantity;
  product.inventoryBaseStock = inventoryStock(product) + quantity;
  clearInventoryDraftProducts([product.id]);
  state.transactions.unshift({
    id: createId(),
    type: "restock",
    productId: product.id,
    productName: product.name,
    amount: 0,
    quantity,
    createdAt: new Date().toISOString(),
  });
  saveState();
  render();
  if (options.focusProductId) {
    const next = $(`.restock-quantity[data-product-id="${options.focusProductId}"]:not(:disabled)`);
    next?.focus();
    next?.select();
  }
  toast("Remplissage enregistre.");
}

function restockFrozenProductFromRow(productId, options = {}) {
  const product = state.products.find((candidate) => candidate.id === productId);
  const input = $(`.restock-frozen-quantity[data-product-id="${productId}"]`);
  const quantity = Number(input?.value);

  if (!product || quantity <= 0) return;

  product.displayStock += quantity;
  product.reserveStock = product.displayStock;
  product.inventoryBaseStock = product.displayStock;
  clearInventoryDraftProducts([product.id]);
  state.transactions.unshift({
    id: createId(),
    type: "restock",
    productId: product.id,
    productName: product.name,
    amount: 0,
    quantity,
    createdAt: new Date().toISOString(),
  });
  input.value = "";
  saveState();
  render();
  if (options.focusProductId) {
    const next = $(`.restock-quantity[data-product-id="${options.focusProductId}"]:not(:disabled)`);
    next?.focus();
    next?.select();
  }
  toast("Stock ajouté.");
}

function handleRestockKeyboard(event) {
  const inputs = $$(".restock-quantity:not(:disabled)");
  const currentIndex = inputs.indexOf(event.currentTarget);
  let nextIndex = null;

  if (event.key === "ArrowDown" || event.key === "Enter") nextIndex = currentIndex + 1;
  if (event.key === "ArrowUp") nextIndex = currentIndex - 1;
  if (nextIndex === null) return;

  event.preventDefault();
  const currentProductId = event.currentTarget.dataset.productId;
  const nextProductId = inputs[Math.max(0, Math.min(nextIndex, inputs.length - 1))]?.dataset.productId;

  if (event.key === "Enter") {
    const product = state.products.find((candidate) => candidate.id === currentProductId);
    if (product?.category === "frozen") {
      restockFrozenProductFromRow(currentProductId, { focusProductId: nextProductId });
    } else {
      restockProductFromRow(currentProductId, { focusProductId: nextProductId });
    }
    return;
  }

  const next = inputs[Math.max(0, Math.min(nextIndex, inputs.length - 1))];
  next?.focus();
  next?.select();
}

function handleInventoryKeyboard(event) {
  const inputs = $$(".inventory-count-field input:not(:disabled)");
  const currentIndex = inputs.indexOf(event.currentTarget);

  if (event.key === "ArrowDown") {
    event.preventDefault();
    inputs[Math.min(currentIndex + 1, inputs.length - 1)]?.focus();
    inputs[Math.min(currentIndex + 1, inputs.length - 1)]?.select();
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    inputs[Math.max(currentIndex - 1, 0)]?.focus();
    inputs[Math.max(currentIndex - 1, 0)]?.select();
  }

  if (event.key === "Enter") {
    event.preventDefault();
    inputs[Math.min(currentIndex + 1, inputs.length - 1)]?.focus();
    inputs[Math.min(currentIndex + 1, inputs.length - 1)]?.select();
  }
}

function focusNextInventoryMobileField(currentInput) {
  const fields = $$("#inventory-mobile-form input:not(:disabled)");
  const currentIndex = fields.indexOf(currentInput);
  const nextField = fields[Math.min(currentIndex + 1, fields.length - 1)];
  nextField?.focus();
  nextField?.select();
}

function handleInventoryMobileKeyboard(event) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  focusNextInventoryMobileField(event.currentTarget);
}

function syncInventoryDraftFromInput(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  if (input.name === "cashCounted" || input.name === "cashRetained") {
    inventoryCashValues[input.name] = input.value;
    state.inventoryDraft[input.name] = input.value;
    setInventoryDraftField(input.name, input.value);
  }
}

function inventoryExpectedCash() {
  return inventorySalesValue($("#inventory-form"));
}

function submitInventory(event) {
  event.preventDefault();
  const form = event.currentTarget;
  syncInventoryDraftFromForm(form);
  if (!validateCashRetained(form)) return;
  if (!confirmInventoryClose()) return;
  const balance = inventoryBalance(form);
  const expectedCash = balance.salesValue;
  const cashCounted = parseMoneyInput(inventoryMoneyValue(form, "cashCounted"));
  const cashRetained = parseMoneyInput(inventoryMoneyValue(form, "cashRetained"));
  const countedProducts = [];

  state.products.forEach((product) => {
    const countedStock = Number(form.elements[`product-${product.id}`].value);
    const previousStock = inventoryStock(product);
    countedProducts.push({
      productId: product.id,
      name: product.name,
      countedTotal: countedStock,
      previousTotal: previousStock,
      variance: countedStock - previousStock,
    });
    product.displayStock = Math.max(0, countedStock);
    product.inventoryBaseStock = product.displayStock;
  });

  const inventory = {
    id: createId(),
    type: "inventory",
    expectedCash,
    cashCounted,
    cashRetained,
    openingCash: balance.openingCash,
    cashWithdrawals: balance.withdrawn,
    creditBalance: balance.creditBalance,
    settlementTotal: balance.settlementTotal,
    cashVariance: balance.variance,
    products: countedProducts,
    createdAt: new Date().toISOString(),
  };

  state.inventories.unshift(inventory);
  state.lastInventoryAt = inventory.createdAt;
  state.cashRetained = Math.max(0, cashRetained);
  clearInventoryDraft();
  saveState();
  render();
  toast("Inventaire cloture.");
}

function renderInventoryMobile() {
  if (activePage() !== "inventaire") return;
  const container = $("#inv-mobile-products");
  const form = $("#inventory-mobile-form");
  if (form) {
    form.elements.cashCounted.value = inventoryDraftMoneyValue("cashCounted");
    form.elements.cashRetained.value = inventoryDraftMoneyValue("cashRetained");
  }
  if (!container) return;
  container.innerHTML = "";

  if (!state.products.length) {
    container.innerHTML = `
      <div class="empty-list-placeholder">
        <i data-lucide="package-x"></i>
        <p>Aucun produit enregistré.</p>
      </div>
    `;
    return;
  }

  const categoryOrder = ["drink", "snack", "frozen"];
  const categoryIcons = { drink: "cup-soda", snack: "cookie", frozen: "snowflake" };

  categoryOrder.forEach((category) => {
    const products = state.products
      .filter((p) => p.category === category)
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));

    if (!products.length) return;

    const section = document.createElement("section");
    section.className = `inv-mobile-category category-${category}`;
    section.innerHTML = `
      <h3>
        <i data-lucide="${categoryIcons[category]}"></i>
        ${categories[category]}
      </h3>
      <div class="inv-mobile-items"></div>
    `;
    const items = section.querySelector(".inv-mobile-items");

    products.forEach((product) => {
      const currentStock = inventoryStock(product);
      const row = document.createElement("div");
      row.className = "inv-mobile-row";
      row.innerHTML = `
        <div class="inv-row-info">
          <strong>${product.name}</strong>
          <div class="inv-row-meta">
            <span>${locations[product.location]}</span>
            <span>Ancien: <strong>${currentStock}</strong></span>
          </div>
        </div>
        <div class="inv-row-controls">
          <button type="button" class="inv-qty-btn inv-dec" data-product-id="${product.id}" aria-label="Diminuer">−</button>
          <input name="product-${product.id}" type="number" min="0" step="1" value="${inventoryDraftValue(product)}" inputmode="numeric" enterkeyhint="next" />
          <button type="button" class="inv-qty-btn inv-inc" data-product-id="${product.id}" aria-label="Augmenter">+</button>
        </div>
      `;
      const input = row.querySelector("input");
      input.addEventListener("focus", (e) => e.currentTarget.select());
      input.addEventListener("input", (event) => {
        setInventoryDraftValue(product.id, event.currentTarget.value);
        updateInventoryMobileSummary();
      });
      input.addEventListener("change", () => updateInventoryMobileSummary());
      input.addEventListener("keydown", handleInventoryMobileKeyboard);
      row.querySelector(".inv-dec").addEventListener("click", () => {
        const val = Number(input.value);
        if (val > 0) input.value = val - 1;
        input.dispatchEvent(new Event("input"));
      });
      row.querySelector(".inv-inc").addEventListener("click", () => {
        input.value = (Number(input.value) || 0) + 1;
        input.dispatchEvent(new Event("input"));
      });
      items.append(row);
    });

    container.append(section);
  });

  updateInventoryMobileSummary();
}

function updateInventoryMobileSummary() {
  const form = $("#inventory-mobile-form");
  const summary = $("#inv-mobile-summary");
  if (!form || !summary) return;

  const balance = inventoryBalance(form);
  const varianceText = balance.variance >= 0 ? `+${formatMoney(balance.variance)}` : formatMoney(balance.variance);

  summary.innerHTML = `
    <div class="inv-summary-row">
      <span>Ventes attendues</span>
      <strong>${formatMoney(balance.salesValue)}</strong>
    </div>
    <div class="inv-summary-row">
      <span>Fond caisse départ</span>
      <strong>${formatMoney(balance.openingCash)}</strong>
    </div>
    <div class="inv-summary-row">
      <span>Caisse frigo</span>
      <strong>${formatMoney(balance.cashCounted)}</strong>
    </div>
    <div class="inv-summary-row">
      <span>Retrait caisse</span>
      <strong>${formatMoney(balance.withdrawn)}</strong>
    </div>
    <div class="inv-summary-row">
      <span>Crédit / avoir</span>
      <strong>${inventoryCreditBalanceLabel()}</strong>
    </div>
    <div class="inv-summary-row text-muted">
      <span>Écart inventaire</span>
      <strong class="${balance.variance < 0 ? "danger" : "success"}">${varianceText}</strong>
    </div>
  `;
}

function submitInventoryMobile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  syncInventoryDraftFromForm(form);
  if (!validateCashRetained(form)) return;
  if (!confirmInventoryClose()) return;
  const balance = inventoryBalance(form);
  const expectedCash = balance.salesValue;
  const countedProducts = [];

  state.products.forEach((product) => {
    const previousStock = inventoryStock(product);
    const countedStock = Number(form.elements[`product-${product.id}`].value);
    countedProducts.push({
      productId: product.id,
      name: product.name,
      countedTotal: countedStock,
      previousTotal: previousStock,
      variance: countedStock - previousStock,
    });
    product.displayStock = Math.max(0, countedStock);
    product.inventoryBaseStock = product.displayStock;
  });

  const cashCounted = parseMoneyInput(inventoryMoneyValue(form, "cashCounted"));
  const cashRetained = parseMoneyInput(inventoryMoneyValue(form, "cashRetained"));

  const inventory = {
    id: createId(),
    type: "inventory",
    expectedCash,
    cashCounted,
    cashRetained,
    openingCash: balance.openingCash,
    cashWithdrawals: balance.withdrawn,
    creditBalance: balance.creditBalance,
    settlementTotal: balance.settlementTotal,
    cashVariance: balance.variance,
    products: countedProducts,
    createdAt: new Date().toISOString(),
  };

  state.inventories.unshift(inventory);
  state.lastInventoryAt = inventory.createdAt;
  state.cashRetained = Math.max(0, cashRetained);
  clearInventoryDraft();
  saveState();
  render();
  const needsRestock = state.products.some((p) => p.restockTarget > p.displayStock);
  if (needsRestock) {
    $("#inventory-mobile-form").classList.add("hidden");
    $("#inv-mobile-restock").classList.remove("hidden");
    renderMobileRestockAfterInventory();
  } else {
    toast("Inventaire clôturé. Tous les produits sont à la cible.");
  }
}

function renderMobileRestockAfterInventory() {
  const container = $("#inv-mobile-restock-list");
  container.innerHTML = "";

  const toRestock = state.products.filter((p) => p.restockTarget > p.displayStock);

  if (!toRestock.length) {
    $("#inv-mobile-restock").classList.add("hidden");
    $("#inventory-mobile-form").classList.remove("hidden");
    return;
  }

  const categoryOrder = ["drink", "snack", "frozen"];
  const categoryIcons = { drink: "cup-soda", snack: "cookie", frozen: "snowflake" };

  categoryOrder.forEach((category) => {
    const products = toRestock
      .filter((p) => p.category === category)
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));

    if (!products.length) return;

    const section = document.createElement("section");
    section.className = `inv-mobile-category category-${category}`;
    section.innerHTML = `
      <h3><i data-lucide="${categoryIcons[category]}"></i> ${categories[category]}</h3>
      <div class="inv-mobile-items"></div>
    `;
    const items = section.querySelector(".inv-mobile-items");

    products.forEach((product) => {
      const missing = product.restockTarget - product.displayStock;
      const row = document.createElement("div");
      row.className = "inv-mobile-row restock-after-inv-row";
      row.dataset.productId = product.id;
      row.innerHTML = `
        <div class="restock-after-inv-top">
          <div class="inv-row-info">
            <strong>${product.name}</strong>
            <div class="inv-row-meta">
              <span>Cible: <strong>${product.restockTarget}</strong></span>
              <span>Stock: <strong>${product.displayStock}</strong></span>
            </div>
          </div>
          <div class="restock-after-inv-missing">
            <span>Manque</span>
            <strong>${missing}</strong>
          </div>
        </div>
        <div class="restock-after-inv-controls">
          <input class="restock-after-inv-input" type="number" min="0" max="${missing}" step="1" value="${missing}" inputmode="numeric" />
          <button class="primary-button restock-after-inv-btn" type="button" data-product-id="${product.id}" style="height:40px;padding:0 12px;font-size:0.8rem">
            <i data-lucide="package-plus"></i>
            Ajouter
          </button>
        </div>
      `;
      items.append(row);
    });

    container.append(section);
  });

  if (window.lucide) window.lucide.createIcons();
}

function submitMemberCredit(event) {
  event.preventDefault();
  const amount = Number(new FormData(event.currentTarget).get("amount"));
  if (!recordPayment(actionMemberId, amount)) return;
  clearQuickCreditSelection();
  render();
  $("#member-action-dialog").close();
  $("#member-action-dialog").classList.remove("credit-only-dialog");
  event.currentTarget.reset();
  toast("Compte crédité.");
}

function renderCashWithdrawalDialog() {
  const form = $("#cash-withdrawal-form");
  if (!form) return;
  const select = form.elements.memberId;
  const members = maintenanceMembers();
  select.innerHTML = members.length
    ? members.map((member) => `<option value="${member.id}">${escapeAttribute(member.name)}</option>`).join("")
    : `<option value="">Aucun équipier maintenance</option>`;
  select.disabled = !members.length;
  form.querySelector('button[type="submit"]').disabled = !members.length;
}

function openCashWithdrawalDialog() {
  const form = $("#cash-withdrawal-form");
  form.reset();
  renderCashWithdrawalDialog();
  $("#cash-withdrawal-dialog").showModal();
}

function submitCashWithdrawal(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const member = state.members.find((candidate) => candidate.id === data.memberId && candidate.group === "maintenance");
  const amount = Number(data.amount);
  if (!member) {
    toast("Selectionnez un equipier maintenance.");
    return;
  }
  if (amount <= 0) return;

  state.transactions.unshift({
    id: createId(),
    type: "cash-withdrawal",
    memberId: member.id,
    memberName: member.name,
    amount,
    createdAt: new Date().toISOString(),
  });
  saveState();
  render();
  $("#cash-withdrawal-dialog").close();
  event.currentTarget.reset();
  toast("Retrait caisse enregistré.");
}

function clearQuickCreditSelection() {
  $$("[data-credit-amount]").forEach((button) => button.classList.remove("active"));
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `frigo-equipe-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const imported = JSON.parse(reader.result);
      state = normalizeState({
        ...structuredClone(demoState),
        ...imported,
        products: imported.products ?? [],
        members: imported.members ?? [],
        transactions: imported.transactions ?? [],
        inventories: imported.inventories ?? [],
      });
      actionMemberId = null;
      cart = [];
      saveState();
      render();
      toast("Donnees importees.");
    } catch {
      toast("Fichier JSON invalide.");
    }
  });
  reader.readAsText(file);
  event.target.value = "";
}

function bindEvents() {
  $$("[data-management-section]").forEach((button) => {
    button.addEventListener("click", () => {
      const section = button.dataset.managementSection;
      $$("[data-management-section]").forEach((item) => item.classList.toggle("active", item === button));
      $$("[data-section-panel]").forEach((panel) => {
        panel.classList.toggle("active-management-section", panel.dataset.sectionPanel === section);
      });
      if (window.lucide) window.lucide.createIcons();
    });
  });

  $$(".tabs button").forEach((button) => {
    button.addEventListener("click", () => {
      selectedCategory = button.dataset.category;
      $$(".tabs button").forEach((tab) => tab.classList.toggle("active", tab === button));
      renderKioskProducts();
      if (window.lucide) window.lucide.createIcons();
    });
  });

  $("#cash-checkout").addEventListener("click", showCashChangePanel);
  $("#cash-dialog").addEventListener("click", applyCashPreset);
  $("#cash-received").addEventListener("input", updateCashChange);
  $("#confirm-cash-checkout").addEventListener("click", () => checkout("cash"));
  $("#cash-dialog-close").addEventListener("click", hideCashChangePanel);
  $("#cash-dialog").addEventListener("close", () => {
    $("#cash-received").value = "";
    $("#cash-change").textContent = formatMoney(0);
  });
  $("#credit-checkout").addEventListener("click", openCreditMemberSelection);
  $("#clear-cart").addEventListener("click", () => {
    cart = [];
    hideCashChangePanel();
    renderCart();
  });
  $("#open-credit-account").addEventListener("click", openCreditAccountSelection);
  $("#kiosk-back-to-products").addEventListener("click", closeCreditMemberSelection);
  $("#credit-member-group-buttons").addEventListener("click", (event) => {
    const button = event.target.closest("[data-member-group]");
    if (!button) return;
    memberGroupFilter = button.dataset.memberGroup;
    renderCreditMemberFilters();
    renderCreditMembers();
  });
  $("#credit-member-letter-buttons").addEventListener("click", (event) => {
    const button = event.target.closest("[data-member-letter]");
    if (!button) return;
    memberLetterFilter = button.dataset.memberLetter;
    renderCreditMemberFilters();
    renderCreditMembers();
  });
  $("#credit-member-list").addEventListener("click", (event) => {
    const card = event.target.closest(".member-card");
    if (!card) return;
    const memberId = card.dataset.memberId;
    if (!memberId) return;

    if (creditOverlayMode === "credit-account") {
      openMemberCreditDialog(memberId);
      return;
    }

    const member = state.members.find((m) => m.id === memberId);
    if (!member) return;
    const total = cartTotal();
    if (!confirm(`Confirmer l'achat à crédit pour ${member.name} ?\nMontant : ${formatMoney(total)}\nNouveau solde : ${memberBalanceLabel({ ...member, balance: member.balance + total })}`)) return;
    startCreditPurchase(memberId);
  });
  $("#kiosk-credit-member-form").addEventListener("submit", addMemberFromKiosk);
  $("#member-credit-account").addEventListener("click", () => {
    const form = $("#member-credit-form");
    form.classList.toggle("hidden");
    if (form.classList.contains("hidden")) {
      form.reset();
      clearQuickCreditSelection();
      return;
    }
  });
  $$("[data-credit-amount]").forEach((button) => {
    button.addEventListener("click", () => {
      clearQuickCreditSelection();
      button.classList.add("active");
      const input = $("#member-credit-form input[name='amount']");
      input.value = Number(button.dataset.creditAmount).toFixed(2);
      input.focus();
    });
  });
  $("#member-credit-form").addEventListener("submit", submitMemberCredit);
  $("#member-action-close").addEventListener("click", () => $("#member-action-dialog").close());
  $("#member-action-dialog").addEventListener("close", () => {
    $("#member-action-dialog").classList.remove("credit-only-dialog");
  });
  $("#open-cash-withdrawal").addEventListener("click", openCashWithdrawalDialog);
  $("#cash-withdrawal-form").addEventListener("submit", submitCashWithdrawal);
  $("#cash-withdrawal-close").addEventListener("click", () => $("#cash-withdrawal-dialog").close());
  $("#cancel-cash-withdrawal").addEventListener("click", () => $("#cash-withdrawal-dialog").close());
  $("#open-product-form").addEventListener("click", openProductForm);
  $("#product-form").addEventListener("submit", submitProduct);
  $("#product-form").elements.category.addEventListener("change", () => {
    applyDefaultProductPrice();
    const category = $("#product-form").elements.category.value;
    if (category === "frozen") {
      $("#product-form").elements.reserveStock.disabled = true;
    } else {
      $("#product-form").elements.reserveStock.disabled = false;
    }
  });
  $("#member-edit-form").addEventListener("submit", submitMemberEdit);
  $("#member-form").addEventListener("submit", submitMember);
  $("#inventory-form").addEventListener("submit", submitInventory);
  $("#inventory-form").addEventListener("input", (event) => {
    syncInventoryDraftFromInput(event);
    updateInventorySummary();
  });
  $("#inventory-mobile-form").addEventListener("submit", submitInventoryMobile);
  $("#inventory-mobile-form").addEventListener("input", (event) => {
    syncInventoryDraftFromInput(event);
    updateInventoryMobileSummary();
  });
  $$("#inventory-form input[name='cashCounted'], #inventory-form input[name='cashRetained'], #inventory-mobile-form .inv-mobile-cash input").forEach((input) => {
    input.addEventListener("focus", focusMoneyInput);
    input.addEventListener("input", rememberMoneyInput);
    input.addEventListener("beforeinput", rememberMoneyInputSoon);
    input.addEventListener("change", rememberMoneyInput);
    input.addEventListener("keyup", rememberMoneyInput);
    input.addEventListener("keydown", rememberMoneyInputSoon);
    input.addEventListener("blur", rememberMoneyInput);
    input.addEventListener("compositionend", rememberMoneyInput);
    input.addEventListener("paste", rememberMoneyInputSoon);
  });
  $$("#inventory-mobile-form .inv-mobile-cash input").forEach((input) => {
    input.addEventListener("keydown", handleInventoryMobileKeyboard);
  });
  $("#inv-mobile-restock-done").addEventListener("click", () => {
    $("#inv-mobile-restock").classList.add("hidden");
    $("#inventory-mobile-form").classList.remove("hidden");
  });
  $("#inv-mobile-restock-list").addEventListener("click", (event) => {
    const btn = event.target.closest(".restock-after-inv-btn");
    if (!btn) return;
    const productId = btn.dataset.productId;
    const product = state.products.find((c) => c.id === productId);
    const row = btn.closest(".restock-after-inv-row");
    const input = row.querySelector(".restock-after-inv-input");
    if (!product || !input) return;

    const quantity = Number(input.value);
    if (quantity <= 0) return;
    const maxAdd = product.restockTarget - product.displayStock;
    const qty = Math.min(quantity, maxAdd);
    if (qty <= 0) return;

    product.displayStock += qty;
    if (product.category === "frozen") product.reserveStock = product.displayStock;
    product.inventoryBaseStock = product.displayStock;
    state.transactions.unshift({
      id: createId(),
      type: "restock",
      productId: product.id,
      productName: product.name,
      amount: 0,
      quantity: qty,
      createdAt: new Date().toISOString(),
    });
    saveState();
    renderMobileRestockAfterInventory();
  });
  $("#export-data").addEventListener("click", exportData);
  $("#import-data-button").addEventListener("click", () => $("#import-data").click());
  $("#import-data").addEventListener("change", importData);
  $("#cancel-product-edit").addEventListener("click", () => {
    $("#product-form").reset();
    $("#product-form").elements.id.value = "";
    $("#product-dialog").close();
  });
  $("#cancel-member-edit").addEventListener("click", () => {
    $("#member-edit-form").reset();
    $("#member-edit-form").elements.id.value = "";
    $("#member-edit-dialog").close();
  });
}

async function boot() {
  state = await loadState();
  bindEvents();
  render();
  listenStateSync();
}

function listenStateSync() {
  const source = new EventSource(SSE_URL);
  source.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "state-updated") {
      if (syncPaused) {
        pendingSync = true;
        return;
      }
      await refreshStateFromServer();
    }
  };
  source.onerror = () => {};
}

async function refreshStateFromServer() {
  state = await loadState();
  render();
}

boot();
