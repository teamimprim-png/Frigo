const STORAGE_KEY = "frigo-equipe-v1";
const API_STATE_URL = "/api/state";

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
    { id: crypto.randomUUID(), name: "Coca", price: 1.2, category: "drink", location: "fridge", displayStock: 12, reserveStock: 24 },
    { id: crypto.randomUUID(), name: "Eau petillante", price: 0.8, category: "drink", location: "fridge", displayStock: 10, reserveStock: 18 },
    { id: crypto.randomUUID(), name: "Barre chocolat", price: 1, category: "snack", location: "fridge", displayStock: 15, reserveStock: 20 },
    { id: crypto.randomUUID(), name: "Pizza", price: 3.5, category: "frozen", location: "freezer", displayStock: 6, reserveStock: 12 },
    { id: crypto.randomUUID(), name: "Glace", price: 1.5, category: "frozen", location: "freezer", displayStock: 8, reserveStock: 16 },
  ],
  members: [
    { id: crypto.randomUUID(), name: "Alex", group: "chauffeur", balance: 0 },
    { id: crypto.randomUUID(), name: "Camille", group: "maintenance", balance: 0 },
    { id: crypto.randomUUID(), name: "Sam", group: "roto", balance: 0 },
  ],
  transactions: [],
  inventories: [],
  lastInventoryAt: null,
};

let state = null;
let selectedMemberId = null;
let actionMemberId = null;
let memberSearch = "";
let memberGroupFilter = null;
let memberLetterFilter = "all";
let memberSort = "az";
let purchaseMode = false;
let selectedCategory = "all";
let cart = [];

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
  return window.location.pathname === "/gestion" ? "management" : "kiosk";
}

async function loadState() {
  try {
    const response = await fetch(API_STATE_URL, { headers: { Accept: "application/json" } });
    if (response.ok) {
      setSyncStatus("Données serveur chargées", "ok");
      return normalizeState(await response.json());
    }
  } catch {
    setSyncStatus("Mode local", "warning");
  }

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
  nextState.members = (nextState.members ?? []).map((member) => ({
    ...member,
    group: memberGroups[member.group] ? member.group : "autre",
    balance: Number(member.balance) || 0,
  }));
  return nextState;
}

async function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  try {
    const response = await fetch(API_STATE_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });

    if (!response.ok) throw new Error("Server rejected state");
    setSyncStatus("Synchronisé", "ok");
  } catch {
    setSyncStatus("Sauvegarde locale", "warning");
  }
}

function setSyncStatus(message, tone = "neutral") {
  const node = $("#sync-status");
  if (!node) return;
  node.textContent = message;
  node.dataset.tone = tone;
}

function formatMoney(value) {
  return moneyFormatter.format(Number(value) || 0);
}

function formatDate(value) {
  return dateFormatter.format(new Date(value));
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
    .filter((transaction) => (transaction.type === "sale" && transaction.payment === "cash") || transaction.type === "payment")
    .reduce((sum, transaction) => sum + transaction.amount, 0);
}

function totalCredit() {
  return state.members.reduce((sum, member) => sum + Math.max(0, member.balance), 0);
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
  renderKioskPurchaseMode();
  renderMemberControls();
  renderMembers();
  renderKioskProducts();
  renderCart();
  renderStats();
  renderProductManagement();
  renderMemberManagement();
  renderRestock();
  renderInventory();
  renderHistory();
  renderMemberActionDialog();
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function renderMemberControls() {
  const letterButtons = $("#member-letter-buttons");
  if (letterButtons) {
    const letters = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index));
    letterButtons.innerHTML = [
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

  const groupButtons = $("#member-group-buttons");
  if (groupButtons) {
    groupButtons.innerHTML = [
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

  $$('select[name="group"]').forEach((select) => {
    const currentValue = select.value || "autre";
    select.innerHTML = Object.entries(memberGroups)
      .map(([value, label]) => `<option value="${value}">${label}</option>`)
      .join("");
    select.value = memberGroups[currentValue] ? currentValue : "autre";
  });

}

function renderKioskPurchaseMode() {
  const member = state.members.find((candidate) => candidate.id === selectedMemberId);
  const context = $("#purchase-context");
  if (!context || !member) return;

  context.innerHTML = `
    <div>
      <span class="context-label">Achat en cours</span>
      <strong>${member.name}</strong>
      <small>${memberBalanceLabel(member)}</small>
    </div>
    <button id="cancel-purchase-mode" class="secondary-button" type="button">
      <i data-lucide="x"></i>
      Changer
    </button>
  `;

  $("#cancel-purchase-mode").addEventListener("click", () => {
    purchaseMode = false;
    cart = [];
    $("#purchase-dialog").close();
    render();
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

function renderMembers() {
  const picker = $("#member-picker");
  picker.innerHTML = "";

  if (activePage() === "kiosk" && !memberGroupFilter) {
    selectedMemberId = null;
    picker.innerHTML = `
      <div class="kiosk-home">
        <div class="kiosk-home-icon">
          <i data-lucide="store"></i>
        </div>
        <h3>Bienvenue au kiosque</h3>
        <p>Sélectionnez une catégorie dans la barre latérale pour afficher les équipiers.</p>
      </div>
    `;
    return;
  }

  if (!state.members.length) {
    picker.innerHTML = "<p class='empty-placeholder'>Aucun équipier. Ajoutez-en un depuis le kiosque.</p>";
    selectedMemberId = null;
    purchaseMode = false;
    return;
  }

  if (!state.members.some((member) => member.id === selectedMemberId)) {
    selectedMemberId = state.members[0].id;
  }

  const normalizedSearch = memberSearch.trim().toLowerCase();
  const visibleMembers = state.members
    .filter((member) => member.name.toLowerCase().includes(normalizedSearch))
    .filter((member) => memberLetterFilter === "all" || member.name.trim().toLocaleUpperCase("fr-FR").startsWith(memberLetterFilter))
    .filter((member) => memberGroupFilter === "all" || member.group === memberGroupFilter)
    .sort(sortMembers);

  if (!visibleMembers.length) {
    picker.innerHTML = "<p class='empty-placeholder'>Aucun équipier trouvé.</p>";
    return;
  }

  visibleMembers.forEach((member) => {
    const card = document.createElement("article");
    card.className = "member-card";
    card.classList.toggle("active", member.id === selectedMemberId);
    const hasDebt = member.balance > 0;
    card.classList.toggle("has-debt", hasDebt);
    card.classList.toggle("has-prepaid", member.balance < 0);
    card.innerHTML = `
      <div class="member-details">
        <span class="member-name">${member.name}</span>
        <span class="member-balance ${memberBalanceClass(member)}">${memberBalanceLabel(member)}</span>
      </div>
      <div class="member-card-actions">
        <button class="primary-button" type="button" data-member-action="purchase">
          <i data-lucide="shopping-cart"></i>
          Achat
        </button>
        <button class="secondary-button" type="button" data-member-action="credit">
          <i data-lucide="coins"></i>
          Créditer
        </button>
      </div>
    `;
    card.querySelector('[data-member-action="purchase"]').addEventListener("click", () => {
      startPurchaseForMember(member.id);
    });
    card.querySelector('[data-member-action="credit"]').addEventListener("click", () => {
      openMemberCreditDialog(member.id);
    });
    picker.append(card);
  });
}

function sortMembers(a, b) {
  if (memberSort === "za") return b.name.localeCompare(a.name, "fr");
  if (memberSort === "credit-desc") return b.balance - a.balance || a.name.localeCompare(b.name, "fr");
  if (memberSort === "credit-asc") return a.balance - b.balance || a.name.localeCompare(b.name, "fr");
  return a.name.localeCompare(b.name, "fr");
}

function openMemberActionDialog(memberId) {
  actionMemberId = memberId;
  $("#member-action-dialog").classList.remove("credit-only-dialog");
  $("#member-credit-form").classList.add("hidden");
  $("#member-credit-form").reset();
  clearQuickCreditSelection();
  renderMemberActionDialog();
  $("#member-action-dialog").showModal();
}

function openMemberCreditDialog(memberId) {
  actionMemberId = memberId;
  renderMemberActionDialog();
  $("#member-action-dialog").classList.add("credit-only-dialog");
  $("#member-credit-form").reset();
  clearQuickCreditSelection();
  $("#member-credit-form").classList.remove("hidden");
  $("#member-action-dialog").showModal();
  $("#member-credit-form input[name='amount']").focus();
}

function startPurchaseForMember(memberId) {
  const member = state.members.find((candidate) => candidate.id === memberId);
  if (!member) return;
  selectedMemberId = member.id;
  actionMemberId = member.id;
  purchaseMode = true;
  cart = [];
  render();
  $("#purchase-dialog").showModal();
  toast(`Achat pour ${member.name}.`);
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
  if (!purchaseMode) return;

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

  $("#cash-change-panel").classList.remove("hidden");
  $("#cash-received").value = cartTotal().toFixed(2);
  updateCashChange();
  $("#cash-received").focus();
}

function hideCashChangePanel() {
  const panel = $("#cash-change-panel");
  if (!panel) return;
  panel.classList.add("hidden");
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

function checkout(payment) {
  const member = state.members.find((candidate) => candidate.id === selectedMemberId);
  if (!member) {
    toast("Selectionnez un equipier.");
    return;
  }
  if (!cart.length) {
    toast("Ajoutez au moins un produit.");
    return;
  }

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
  }

  const amount = cartTotal();
  if (payment === "credit") {
    member.balance += amount;
  }

  state.transactions.unshift({
    id: crypto.randomUUID(),
    type: "sale",
    payment,
    memberId: member.id,
    memberName: member.name,
    amount,
    lines,
    createdAt: new Date().toISOString(),
  });

  cart = [];
  purchaseMode = false;
  hideCashChangePanel();
  saveState();
  $("#purchase-dialog").close();
  render();
  toast(payment === "cash" ? "Vente en especes enregistree." : "Vente ajoutee au credit.");
}

function recordPayment(memberId, amount) {
  const member = state.members.find((candidate) => candidate.id === memberId);
  if (!member || amount <= 0) return false;

  member.balance -= amount;
  state.transactions.unshift({
    id: crypto.randomUUID(),
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
  const stockValue = state.products.reduce((sum, product) => sum + (product.displayStock + product.reserveStock) * product.price, 0);
  const lowProducts = state.products.filter((product) => product.displayStock <= 2).length;
  const expectedCash = periodExpectedCash();

  const statsData = [
    { label: "Caisse théorique", value: formatMoney(expectedCash), hint: "Depuis le dernier inventaire", icon: "wallet", class: "stat-cash" },
    { label: "Crédits ouverts", value: formatMoney(totalCredit()), hint: "Total des équipiers", icon: "credit-card", class: "stat-credit" },
    { label: "Valeur du stock", value: formatMoney(stockValue), hint: "Rayon et réserve", icon: "package", class: "stat-stock" },
    { label: "Alertes stock", value: String(lowProducts), hint: "Produits à remplir (≤ 2)", icon: "alert-triangle", class: lowProducts > 0 ? "stat-alert danger" : "stat-alert" }
  ];

  $("#stats").innerHTML = statsData.map(stat => `
    <article class="stat-card ${stat.class}">
      <div class="stat-icon-wrapper">
        <i data-lucide="${stat.icon}"></i>
      </div>
      <div class="stat-details">
        <span class="stat-label">${stat.label}</span>
        <strong>${stat.value}</strong>
        <small>${stat.hint}</small>
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

  state.products.forEach((product) => {
    const row = document.createElement("div");
    row.className = "table-row product-manage-row";
    row.innerHTML = `
      <div class="row-info">
        <div class="row-title">
          <strong>${product.name}</strong>
          <span class="pill-category category-${product.category}">${categories[product.category]}</span>
        </div>
        <div class="row-meta">
          <span><i data-lucide="tag"></i> ${formatMoney(product.price)}</span>
          <span><i data-lucide="map-pin"></i> ${locations[product.location]}</span>
          <span><i data-lucide="layout-grid"></i> Rayon: <strong>${product.displayStock}</strong></span>
          <span><i data-lucide="archive"></i> Réserve: <strong>${product.reserveStock}</strong></span>
        </div>
      </div>
      <div class="row-actions">
        <button class="secondary-button" data-action="edit" title="Modifier">
          <i data-lucide="edit-2"></i>
          <span>Modifier</span>
        </button>
        <button class="danger-button" data-action="delete" title="Supprimer">
          <i data-lucide="trash-2"></i>
          <span>Supprimer</span>
        </button>
      </div>
    `;
    row.querySelector('[data-action="edit"]').addEventListener("click", () => editProduct(product.id));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => deleteProduct(product.id));
    list.append(row);
  });
}

function editProduct(id) {
  const product = state.products.find((candidate) => candidate.id === id);
  const form = $("#product-form");
  $("#product-dialog-title").textContent = "Modifier le produit";
  for (const [key, value] of Object.entries(product)) {
    if (form.elements[key]) form.elements[key].value = value;
  }
  $("#product-dialog").showModal();
  form.elements.name.focus();
}

function openProductForm() {
  const form = $("#product-form");
  form.reset();
  form.elements.id.value = "";
  $("#product-dialog-title").textContent = "Ajouter un produit";
  $("#product-dialog").showModal();
  form.elements.name.focus();
}

function deleteProduct(id) {
  const product = state.products.find((candidate) => candidate.id === id);
  if (!product || !confirm(`Supprimer ${product.name} ?`)) return;
  state.products = state.products.filter((candidate) => candidate.id !== id);
  cart = cart.filter((item) => item.productId !== id);
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
    const row = document.createElement("div");
    row.className = "table-row member-manage-row";
    row.innerHTML = `
      <div class="row-info">
        <div class="member-manage-header">
          <span class="avatar mini" style="background: ${getAvatarColor(member.name)}">${member.name.slice(0, 2).toUpperCase()}</span>
          <strong>${member.name}</strong>
          <span class="member-group-pill">${memberGroups[member.group]}</span>
        </div>
        <div class="row-meta">
          <span class="${memberBalanceClass(member)}">
            <i data-lucide="credit-card"></i>
            Solde: <strong>${memberBalanceLabel(member)}</strong>
          </span>
        </div>
      </div>
      <div class="row-actions">
        <button class="danger-button" title="Supprimer">
          <i data-lucide="trash-2"></i>
          <span>Supprimer</span>
        </button>
      </div>
    `;
    row.querySelector("button").addEventListener("click", () => {
      if (!confirm(`Supprimer ${member.name} ?`)) return;
      state.members = state.members.filter((candidate) => candidate.id !== member.id);
      if (selectedMemberId === member.id) selectedMemberId = state.members[0]?.id ?? null;
      if (actionMemberId === member.id) actionMemberId = null;
      if (!state.members.some((candidate) => candidate.id === selectedMemberId)) purchaseMode = false;
      saveState();
      render();
    });
    list.append(row);
  });
}

function renderRestock() {
  const list = $("#restock-list");
  if (!state.products.length) {
    list.innerHTML = `
      <div class="empty-list-placeholder">
        <i data-lucide="package-x"></i>
        <p>Aucun produit enregistré.</p>
      </div>
    `;
    return;
  }

  list.innerHTML = `
    <div class="restock-header">
      <span>Produit</span>
      <span>Rayon</span>
      <span>Réserve</span>
      <span>À transférer</span>
      <span>Action</span>
    </div>
    ${state.products
      .slice()
      .sort((a, b) => a.location.localeCompare(b.location) || a.name.localeCompare(b.name, "fr"))
      .map((product) => `
      <div class="restock-row ${product.displayStock <= 2 ? "needs-restock" : ""}" data-product-id="${product.id}">
        <div class="row-info">
          <strong>${product.name}</strong>
          <div class="row-meta">
            <span><i data-lucide="map-pin"></i> ${locations[product.location]}</span>
            <span><i data-lucide="tag"></i> ${categories[product.category]}</span>
          </div>
        </div>
        <strong class="${product.displayStock <= 2 ? "danger" : ""}">${product.displayStock}</strong>
        <strong>${product.reserveStock}</strong>
        <input class="restock-quantity" type="number" min="0" max="${product.reserveStock}" step="1" inputmode="numeric" data-product-id="${product.id}" ${product.reserveStock <= 0 ? "disabled" : ""} />
        <button class="secondary-button restock-line-button" type="button" data-product-id="${product.id}" ${product.reserveStock <= 0 ? "disabled" : ""}>
          <i data-lucide="arrow-right-left"></i>
          Transférer
        </button>
      </div>
    `).join("")}
  `;

  $$(".restock-line-button").forEach((button) => {
    button.addEventListener("click", () => restockProductFromRow(button.dataset.productId));
  });

  $$(".restock-quantity").forEach((input) => {
    input.addEventListener("keydown", handleRestockKeyboard);
  });
}

function renderInventory() {
  const productFields = $("#inventory-products");
  productFields.innerHTML = state.products.map((product) => `
    <label>
      ${product.name} (${locations[product.location]})
      <input name="product-${product.id}" type="number" min="0" step="1" value="${product.displayStock + product.reserveStock}" />
    </label>
  `).join("");

  const expectedCash = periodExpectedCash();
  $("#inventory-summary").innerHTML = `
    <strong>Caisse theorique: ${formatMoney(expectedCash)}</strong><br>
    Credits suivis dans l'app: ${formatMoney(totalCredit())}
  `;
}

function renderHistory() {
  const history = [...state.transactions, ...state.inventories.map((inventory) => ({ ...inventory, type: "inventory" }))]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
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
      sub = `Écart caisse: <strong class="${variance < 0 ? 'danger' : 'success'}">${varianceText}</strong>`;
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
  const product = {
    id: data.id || crypto.randomUUID(),
    name: data.name.trim(),
    price: Number(data.price),
    category: data.category,
    location: data.location,
    displayStock: Number(data.displayStock),
    reserveStock: Number(data.reserveStock),
  };

  const existingIndex = state.products.findIndex((candidate) => candidate.id === product.id);
  if (existingIndex >= 0) state.products[existingIndex] = product;
  else state.products.push(product);

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
  const member = { id: crypto.randomUUID(), name, group: data.group || "autre", balance: 0 };
  state.members.push(member);
  selectedMemberId = member.id;
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
    memberSearch = name;
    memberLetterFilter = "all";
    openMemberActionDialog(existing.id);
    return;
  }

  const member = { id: crypto.randomUUID(), name, group: data.group || "autre", balance: 0 };
  state.members.push(member);
  selectedMemberId = member.id;
  actionMemberId = null;
  purchaseMode = false;
  memberSearch = "";
  memberLetterFilter = member.name.trim().slice(0, 1).toLocaleUpperCase("fr-FR");
  memberGroupFilter = member.group;
  event.currentTarget.reset();
  saveState();
  render();
  toast(`${member.name} ajouté.`);
}

function restockProductFromRow(productId) {
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
  state.transactions.unshift({
    id: crypto.randomUUID(),
    type: "restock",
    productId: product.id,
    productName: product.name,
    amount: 0,
    quantity,
    createdAt: new Date().toISOString(),
  });
  saveState();
  render();
  toast("Remplissage enregistre.");
}

function handleRestockKeyboard(event) {
  const inputs = $$(".restock-quantity:not(:disabled)");
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
    restockProductFromRow(event.currentTarget.dataset.productId);
  }
}

function submitInventory(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const expectedCash = periodExpectedCash();
  const expectedCredit = totalCredit();
  const cashCounted = Number(form.elements.cashCounted.value);
  const creditSheetTotal = Number(form.elements.creditSheetTotal.value);
  const countedProducts = [];

  state.products.forEach((product) => {
    const countedTotal = Number(form.elements[`product-${product.id}`].value);
    const previousTotal = product.displayStock + product.reserveStock;
    countedProducts.push({
      productId: product.id,
      name: product.name,
      countedTotal,
      previousTotal,
      variance: countedTotal - previousTotal,
    });
    product.reserveStock = Math.max(0, countedTotal - product.displayStock);
    if (countedTotal < product.displayStock) {
      product.displayStock = countedTotal;
      product.reserveStock = 0;
    }
  });

  const inventory = {
    id: crypto.randomUUID(),
    type: "inventory",
    expectedCash,
    cashCounted,
    cashVariance: cashCounted - expectedCash,
    expectedCredit,
    creditSheetTotal,
    creditVariance: creditSheetTotal - expectedCredit,
    products: countedProducts,
    createdAt: new Date().toISOString(),
  };

  state.inventories.unshift(inventory);
  state.lastInventoryAt = inventory.createdAt;
  saveState();
  render();
  toast("Inventaire cloture.");
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
      state = {
        ...structuredClone(demoState),
        ...imported,
        products: imported.products ?? [],
        members: imported.members ?? [],
        transactions: imported.transactions ?? [],
        inventories: imported.inventories ?? [],
      };
      selectedMemberId = state.members[0]?.id ?? null;
      actionMemberId = null;
      purchaseMode = false;
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
  $("#cash-received").addEventListener("input", updateCashChange);
  $("#confirm-cash-checkout").addEventListener("click", () => checkout("cash"));
  $("#credit-checkout").addEventListener("click", () => checkout("credit"));
  $("#clear-cart").addEventListener("click", () => {
    cart = [];
    hideCashChangePanel();
    renderCart();
  });
  $("#member-letter-buttons").addEventListener("click", (event) => {
    const button = event.target.closest("[data-member-letter]");
    if (!button) return;
    memberLetterFilter = button.dataset.memberLetter;
    memberSearch = "";
    renderMemberControls();
    renderMembers();
    if (window.lucide) window.lucide.createIcons();
  });
  $("#toggle-member-letter-filter").addEventListener("click", () => {
    const letters = $("#member-letter-buttons");
    const isHidden = letters.classList.toggle("hidden");
    $("#toggle-member-letter-filter").setAttribute("aria-expanded", String(!isHidden));
  });
  $("#member-group-buttons").addEventListener("click", (event) => {
    const button = event.target.closest("[data-member-group]");
    if (!button) return;
    memberGroupFilter = button.dataset.memberGroup;
    renderMemberControls();
    renderMembers();
    if (window.lucide) window.lucide.createIcons();
  });
  $("#toggle-kiosk-member-form").addEventListener("click", () => {
    const form = $("#kiosk-member-form");
    const isHidden = form.classList.toggle("hidden");
    $("#toggle-kiosk-member-form").setAttribute("aria-expanded", String(!isHidden));
    if (!isHidden) {
      form.elements.name.focus();
    }
  });
  $("#member-start-purchase").addEventListener("click", () => {
    const memberId = actionMemberId;
    $("#member-action-dialog").close();
    startPurchaseForMember(memberId);
  });
  $("#member-credit-account").addEventListener("click", () => {
    const form = $("#member-credit-form");
    form.classList.toggle("hidden");
    if (form.classList.contains("hidden")) {
      form.reset();
      clearQuickCreditSelection();
      return;
    }
    if (!form.classList.contains("hidden")) {
      $("#member-credit-form input[name='amount']").focus();
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
  $("#purchase-dialog").addEventListener("cancel", (event) => {
    event.preventDefault();
  });
  $("#open-product-form").addEventListener("click", openProductForm);
  $("#product-form").addEventListener("submit", submitProduct);
  $("#member-form").addEventListener("submit", submitMember);
  $("#kiosk-member-form").addEventListener("submit", addMemberFromKiosk);
  $("#inventory-form").addEventListener("submit", submitInventory);
  $("#export-data").addEventListener("click", exportData);
  $("#import-data").addEventListener("change", importData);
  $("#cancel-product-edit").addEventListener("click", () => {
    $("#product-form").reset();
    $("#product-form").elements.id.value = "";
    $("#product-dialog").close();
  });
  $("#reset-demo").addEventListener("click", () => {
    if (!confirm("Reinitialiser avec les donnees de demonstration ?")) return;
    state = structuredClone(demoState);
    selectedMemberId = state.members[0]?.id ?? null;
    actionMemberId = null;
    purchaseMode = false;
    cart = [];
    saveState();
    render();
  });
}

async function boot() {
  state = await loadState();
  selectedMemberId = state.members[0]?.id ?? null;
  bindEvents();
  render();
}

boot();
