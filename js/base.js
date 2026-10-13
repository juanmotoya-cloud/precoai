"use strict";

// Defina window.PRECOAI_API_BASE_URL no index.html depois de publicar o backend.
const API_BASE = String(window.PRECOAI_API_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function normalizar(texto) {
  return String(texto ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}
function precoFormatado(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) && numero > 0
    ? numero.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
    : "Preço não informado";
}
function elemento(tag, classe, texto) {
  const node = document.createElement(tag);
  if (classe) node.className = classe;
  if (texto !== undefined) node.textContent = texto;
  return node;
}

// MENU LATERAL
const menuToggle = $("#menuToggle");
const sideMenu = $("#sideMenu");
const menuOverlay = $("#menuOverlay");
const closeMenu = $("#closeMenu");
function abrirMenu() {
  sideMenu?.classList.add("open");
  menuOverlay?.classList.add("open");
  document.body.classList.add("menu-open");
  menuToggle?.setAttribute("aria-expanded", "true");
}
function fecharMenu() {
  sideMenu?.classList.remove("open");
  menuOverlay?.classList.remove("open");
  document.body.classList.remove("menu-open");
  menuToggle?.setAttribute("aria-expanded", "false");
}
menuToggle?.addEventListener("click", abrirMenu);
closeMenu?.addEventListener("click", fecharMenu);
menuOverlay?.addEventListener("click", fecharMenu);
document.addEventListener("keydown", event => { if (event.key === "Escape") fecharMenu(); });
$$(".menu-item").forEach(link => link.addEventListener("click", fecharMenu));

// BANNERS
const banners = [
  { tag: "NOTA FISCAL AMAZONENSE", title: "Peça sua nota fiscal e concorra a prêmios!", description: "Peça seu CPF na nota e participe. Confira as regras da campanha.", icon: "./img/SEFAZ-Cidadania-Fiscal174x85-2.png", colors: ["#00843D", "#00A651"], action: "https://nfamazonense.sefaz.am.gov.br/minha-conta/formulario/", external: true },
  { tag: "ECONOMIZE NO SUPERMERCADO", title: "Compare preços antes de comprar!", description: "Encontre opções mais econômicas para sua lista de compras.", icon: "./img/cesta-compras.svg", colors: ["#D32F2F", "#FF7043"], action: ".ofertas-hoje" },
  { tag: "OFERTAS DA REGIÃO", title: "Descubra ofertas perto de você!", description: "Consulte preços e estabelecimentos disponíveis na SEFAZ-AM.", icon: "./img/ofertas.svg", colors: ["#1565C0", "#42A5F5"], action: "#searchForm" },
  { tag: "COMPRE COM INTELIGÊNCIA", title: "Seu dinheiro pode render mais!", description: "Pesquise qualquer produto e compare os preços encontrados.", icon: "./img/economia.svg", colors: ["#6A1B9A", "#AB47BC"], action: "#searchForm" }
];
const banner = $("#promoBanner");
const bannerImage = $("#bannerImage");
const bannerTag = $("#bannerTag");
const bannerTitle = $("#bannerTitle");
const bannerDescription = $("#bannerDescription");
const bannerButton = $("#bannerButton");
const bannerDots = $("#bannerDots");
let bannerAtual = 0;
let timerBanner = null;
function mostrarBanner(index) {
  if (!banner || !bannerTitle || !bannerTag || !bannerDescription || !bannerButton) return;
  bannerAtual = (index + banners.length) % banners.length;
  const data = banners[bannerAtual];
  bannerTag.textContent = data.tag;
  bannerTitle.textContent = data.title;
  bannerDescription.textContent = data.description;
  banner.style.background = `linear-gradient(120deg, ${data.colors[0]}, ${data.colors[1]})`;
  if (bannerImage) {
    bannerImage.hidden = true;
    bannerImage.onload = () => { bannerImage.hidden = false; };
    bannerImage.onerror = () => { bannerImage.hidden = true; };
    bannerImage.src = data.icon;
    bannerImage.alt = data.tag;
  }
  bannerButton.onclick = () => {
    if (data.external) window.open(data.action, "_blank", "noopener,noreferrer");
    else $(data.action)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  $$(".dot", bannerDots || document).forEach((dot, i) => {
    dot.classList.toggle("active", i === bannerAtual);
    dot.setAttribute("aria-current", i === bannerAtual ? "true" : "false");
  });
}
function iniciarBanners() {
  if (!bannerDots) return;
  bannerDots.replaceChildren();
  banners.forEach((data, index) => {
    const dot = elemento("button", `dot${index === 0 ? " active" : ""}`);
    dot.type = "button";
    dot.setAttribute("aria-label", `Mostrar banner ${index + 1}: ${data.tag}`);
    dot.addEventListener("click", () => { mostrarBanner(index); agendarBanners(); });
    bannerDots.appendChild(dot);
  });
}
function agendarBanners() {
  if (timerBanner) clearInterval(timerBanner);
  timerBanner = setInterval(() => mostrarBanner(bannerAtual + 1), 6000);
}
iniciarBanners();
mostrarBanner(0);
agendarBanners();

// PESQUISA AO VIVO NA API QUE CONSULTA O BUSCA PREÇO DA SEFAZ-AM
const searchForm = $("#searchForm");
const searchInput = $("#searchInput");
const searchResults = $("#searchResults");
const searchMessage = $("#searchMessage");
const searchProducts = $("#searchProducts");
let ultimaBusca = "";

function desenharProduto(produto) {
  const card = elemento("article", "search-product-card");
  const header = elemento("div", "search-product-header");
  const imagem = elemento("img", "search-product-image");
  imagem.alt = produto.produto || "Produto";
  imagem.loading = "lazy";
  imagem.src = produto.imagem || "./img/produto-padrao.svg";
  imagem.onerror = () => { imagem.onerror = null; imagem.src = "./img/produto-padrao.svg"; };
  const nome = elemento("h3", "", produto.produto || "Produto sem nome");
  header.append(imagem, nome);
  const preco = elemento("p", "search-product-price", precoFormatado(produto.melhor_preco?.valor));
  const loja = elemento("p", "search-product-store", `Estabelecimento: ${produto.estabelecimento || "Não informado"}`);
  const endereco = elemento("p", "search-product-address", `Endereço: ${produto.endereco || "Não informado"}`);
  card.append(header, preco, loja, endereco);
  if (produto.tempo_nota) card.appendChild(elemento("p", "search-product-time", `Nota fiscal: ${produto.tempo_nota}`));
  return card;
}

async function pesquisar(termo) {
  const busca = String(termo || "").trim();
  if (!searchResults || !searchMessage || !searchProducts) return;
  if (!busca) {
    searchResults.hidden = false;
    searchMessage.textContent = "Digite o nome de um produto para pesquisar.";
    searchProducts.replaceChildren();
    searchInput?.focus();
    return;
  }
  ultimaBusca = busca;
  searchResults.hidden = false;
  searchMessage.textContent = `Consultando a SEFAZ-AM por “${busca}”…`;
  searchProducts.replaceChildren();
  try {
    const url = `${API_BASE}/api/busca-preco?busca=${encodeURIComponent(busca)}`;
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.erro || `Erro HTTP ${response.status}`);
    const products = Array.isArray(data.produtos) ? data.produtos : [];
    if (!products.length) {
      searchMessage.textContent = `A SEFAZ-AM não retornou produtos para “${busca}”. Tente outra palavra ou marca.`;
      return;
    }
    searchMessage.textContent = `${products.length} resultado(s) para “${busca}”. Fonte: ${data.origem || "Busca Preço SEFAZ-AM"}.`;
    if (data.aviso) searchMessage.textContent += ` ${data.aviso}`;
    products.forEach(product => searchProducts.appendChild(desenharProduto(product)));
  } catch (error) {
    console.error("Erro na pesquisa PreçoAí:", error);
    searchMessage.textContent = `${error.message || "Não foi possível consultar os preços."} Confira se o backend está publicado e se PRECOAI_API_BASE_URL aponta para ele.`;
  }
}
searchForm?.addEventListener("submit", event => {
  event.preventDefault();
  pesquisar(searchInput?.value || "");
});

// CATEGORIAS: cada atalho preenche uma busca real, sem limitar a pesquisa a um catálogo local.
const categoryTerms = { ofertas: "refrigerante", mercearia: "arroz", carnes: "frango", alimentos: "pão", limpeza: "detergente", doces: "chocolate" };
$$(".category-item").forEach(item => {
  item.setAttribute("role", "button");
  item.setAttribute("tabindex", "0");
  const run = () => {
    $$(".category-item").forEach(other => other.classList.toggle("active", other === item));
    const term = categoryTerms[item.dataset.cat] || item.textContent.trim();
    if (searchInput) searchInput.value = term;
    pesquisar(term);
    searchResults?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  item.addEventListener("click", run);
  item.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); run(); } });
});

// CESTA: mostra os menores preços do cache de pesquisas anteriores, identificando a origem.
async function carregarCesta() {
  const container = $("#cesta-produtos");
  const status = $("#cesta-status");
  if (!container) return;
  if (status) status.textContent = "Carregando preços disponíveis…";
  try {
    const response = await fetch(`${API_BASE}/api/cesta-basica`, { headers: { Accept: "application/json" } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.erro || `Erro HTTP ${response.status}`);
    container.replaceChildren();
    const categories = Array.isArray(data.categorias) ? data.categorias : [];
    const products = categories.filter(item => item.encontrado && item.menor_preco);
    products.forEach(item => {
      const product = item.menor_preco;
      const card = elemento("article", "product-card");
      const imageBox = elemento("div", "product-image-placeholder");
      const img = elemento("img");
      img.src = product.imagem || "./img/produto-padrao.svg";
      img.alt = product.produto || item.nome;
      img.loading = "lazy";
      img.onerror = () => { img.onerror = null; img.src = "./img/produto-padrao.svg"; };
      imageBox.appendChild(img);
      const info = elemento("div", "product-info");
      const name = elemento("div", "product-name", product.produto || item.nome);
      const price = elemento("span", "current-price", precoFormatado(product.melhor_preco?.valor));
      const priceRow = elemento("div", "price-row");
      priceRow.appendChild(price);
      const store = elemento("p", "", product.estabelecimento || "Estabelecimento não informado");
      const button = elemento("button", "btn-ver", "Pesquisar");
      button.type = "button";
      button.addEventListener("click", () => {
        if (searchInput) searchInput.value = item.nome || product.produto;
        pesquisar(searchInput?.value || product.produto);
        searchResults?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      info.append(name, priceRow, store, button);
      card.append(imageBox, info);
      container.appendChild(card);
    });
    if (status) status.textContent = products.length
      ? `${products.length} categoria(s) com preços no cache. Faça uma pesquisa para consultar e atualizar qualquer produto diretamente na SEFAZ-AM.`
      : "Ainda não há preços pesquisados no cache. Use a busca acima para consultar produtos na SEFAZ-AM.";
  } catch (error) {
    console.error("Erro ao carregar cesta:", error);
    if (status) status.textContent = "Não foi possível carregar a cesta. A busca ao vivo continua disponível quando o backend estiver online.";
  }
}
$("#link-cesta")?.addEventListener("click", event => { event.preventDefault(); carregarCesta(); });
document.addEventListener("DOMContentLoaded", carregarCesta);
