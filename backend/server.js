"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const cheerio = require("cheerio");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = "https://buscapreco.sefaz.am.gov.br";
const PRECO_MINIMO = 1.00;
const TEMPO_CACHE_MS = 5 * 60 * 1000;
const LIMITE_PAGINAS = 20;
const TIMEOUT_MS = 30000;

const DIRETORIO_DADOS = path.join(__dirname, "dados");
const ARQUIVO_JSON = path.join(DIRETORIO_DADOS, "busca-preco.json");
const ARQUIVO_CESTA = path.join(DIRETORIO_DADOS, "cesta-basica-catalogo.json");

const cachePesquisas = new Map();
const pesquisasEmAndamento = new Map();

app.use(express.json({ limit: "1mb" }));
app.use(cors());

function normalizar(texto) {
    return String(texto ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

function converterPreco(texto) {
    let valor = String(texto ?? "")
        .replace(/R\$/gi, "")
        .replace(/\s/g, "")
        .trim();

    if (!valor) return null;

    // Formato brasileiro: 1.234,56. Também aceita valores como 12,50.
    if (valor.includes(",")) {
        valor = valor.replace(/\./g, "").replace(",", ".");
    }

    const numero = Number(valor);
    return Number.isFinite(numero) ? numero : null;
}

function precoDoProduto(produto) {
    const valor = Number(produto?.melhor_preco?.valor);
    return Number.isFinite(valor) ? valor : null;
}

function produtoValido(produto) {
    const nome = String(produto?.produto ?? "").trim();
    const valor = precoDoProduto(produto);
    if (!nome || valor === null || valor < PRECO_MINIMO) return false;
    if (produto.dados_reais === false) return false;
    return true;
}

function obterProdutosSalvos() {
    if (!fs.existsSync(ARQUIVO_JSON)) return { produtos: [], meta: {} };

    try {
        const bruto = JSON.parse(fs.readFileSync(ARQUIVO_JSON, "utf8"));
        const lista = Array.isArray(bruto.produtos)
            ? bruto.produtos
            : Array.isArray(bruto.resultados)
                ? bruto.resultados
                : Array.isArray(bruto.cesta_basica)
                    ? bruto.cesta_basica
                    : [];

        return {
            produtos: lista.filter(produtoValido),
            meta: bruto.meta && typeof bruto.meta === "object" ? bruto.meta : {}
        };
    } catch (erro) {
        console.error("Não foi possível ler busca-preco.json:", erro.message);
        return { produtos: [], meta: {} };
    }
}

function criarId(nome, estabelecimento, endereco) {
    const origem = `${normalizar(nome)}|${normalizar(estabelecimento)}|${normalizar(endereco)}`;
    return Buffer.from(origem).toString("base64url").slice(0, 32);
}

function formatarPreco(valor) {
    return `R$ ${valor.toFixed(2).replace(".", ",")}`;
}

// Consulta a página pública. O servidor não tenta contornar bloqueios ou autenticação.
async function coletarPrecos(termo) {
    const paginaInicial = await fetch(`${BASE_URL}/home`, {
        headers: { "User-Agent": "Mozilla/5.0 PrecoAi/1.0" },
        signal: AbortSignal.timeout(20000)
    });

    if (!paginaInicial.ok) {
        throw new Error(`Falha ao abrir a SEFAZ-AM: HTTP ${paginaInicial.status}`);
    }

    const cookies = paginaInicial.headers.getSetCookie
        ? paginaInicial.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ")
        : "";

    const headers = {
        "User-Agent": "Mozilla/5.0 PrecoAi/1.0",
        "Referer": `${BASE_URL}/home`,
        ...(cookies ? { Cookie: cookies } : {})
    };

    const formulario = new URLSearchParams({
        descricaoProd: termo,
        latitude: "",
        longitude: ""
    });

    const produtosPorId = new Map();

    for (let pagina = 1; pagina <= LIMITE_PAGINAS; pagina++) {
        let resposta;

        if (pagina === 1) {
            resposta = await fetch(`${BASE_URL}/item/grupo/p/1`, {
                method: "POST",
                headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
                body: formulario,
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });
        } else {
            resposta = await fetch(`${BASE_URL}/item/grupo/page/${pagina}`, {
                method: "GET",
                headers,
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });
        }

        if (!resposta.ok) {
            if (pagina === 1) {
                throw new Error(`Falha na pesquisa: HTTP ${resposta.status}`);
            }
            console.warn(`A página ${pagina} retornou HTTP ${resposta.status}; coleta interrompida.`);
            break;
        }

        const html = await resposta.text();
        const $ = cheerio.load(html);
        const cards = $("div.card.small.p.hoverable");
        if (cards.length === 0) break;

        cards.each((_, elemento) => {
            const card = $(elemento);
            const nome = card.find(".card-title").first().text().replace(/\s+/g, " ").trim();
            const textoPreco = card.find(".tb-valor-25 b").first().text().trim();
            const estabelecimento = card.find("p.truncate b").first().text().replace(/\s+/g, " ").trim()
                || "Estabelecimento não identificado";
            const endereco = card.find("span.grey-text").first().text().replace(/\s+/g, " ").trim()
                || "Endereço não informado";
            const tempoNota = card.find("p.tb-valor-10").first().text().replace(/\s+/g, " ").trim() || null;

            const valor = converterPreco(textoPreco);
            const nomeNormalizado = normalizar(nome);
            const estabelecimentoNormalizado = normalizar(estabelecimento);
            const termoNormalizado = normalizar(termo);

            if (!nome || valor === null || valor < PRECO_MINIMO) return;

            // Remove incompatibilidades conhecidas e evita resultados de outra categoria.
            if (
                nomeNormalizado.includes("macarrao oriental") &&
                estabelecimentoNormalizado.includes("china in box")
            ) return;

            if (
                termoNormalizado === "arroz" &&
                (
                    nomeNormalizado.includes("arroz de brocolis") ||
                    nomeNormalizado.includes("arroz-doce") ||
                    nomeNormalizado.includes("arroz doce") ||
                    nomeNormalizado.includes("refil")
                )
            ) return;

            const id = criarId(nome, estabelecimento, endereco);
            produtosPorId.set(id, {
                id,
                produto: nome,
                termo_busca: termo,
                melhor_preco: { valor, moeda: "BRL", texto: formatarPreco(valor) },
                estabelecimento,
                endereco,
                tempo_nota: tempoNota,
                coletado_em: new Date().toISOString(),
                fonte: BASE_URL,
                dados_reais: true
            });
        });

        console.log(`Busca "${termo}" — página ${pagina}: ${cards.length} cartões lidos.`);
        if (pagina < LIMITE_PAGINAS) {
            await new Promise(resolve => setTimeout(resolve, 350));
        }
    }

    const produtos = [...produtosPorId.values()].filter(produtoValido);
    console.log(`Busca "${termo}" concluída: ${produtos.length} ofertas válidas (mínimo R$ ${PRECO_MINIMO.toFixed(2)}).`);
    return produtos;
}

function salvarDados(novosProdutos, termo) {
    fs.mkdirSync(DIRETORIO_DADOS, { recursive: true });

    const antigos = obterProdutosSalvos().produtos;
    const mapa = new Map();

    for (const produto of antigos) {
        if (produtoValido(produto)) mapa.set(produto.id || criarId(produto.produto, produto.estabelecimento, produto.endereco), produto);
    }
    for (const produto of novosProdutos.filter(produtoValido)) {
        const id = produto.id || criarId(produto.produto, produto.estabelecimento, produto.endereco);
        mapa.set(id, { ...produto, id });
    }

    const todosProdutos = [...mapa.values()].filter(produtoValido);
    const dados = {
        app: "PrecoAi",
        meta: {
            ultima_busca: termo,
            total_itens: todosProdutos.length,
            data_atualizacao: new Date().toISOString(),
            fonte: `${BASE_URL}/home`,
            preco_minimo_aplicado: PRECO_MINIMO
        },
        produtos: todosProdutos
    };

    const temporario = `${ARQUIVO_JSON}.tmp`;
    fs.writeFileSync(temporario, JSON.stringify(dados, null, 2), "utf8");
    fs.renameSync(temporario, ARQUIVO_JSON);
}

function excluirResultadoIncompativel(nome, termo) {
    const n = normalizar(nome);
    const t = normalizar(termo);

   


if (t === "arroz") {
    return !n.includes("arroz") ||
        [
            // Pratos preparados e receitas
            "arroz de brocolis",
            "arroz c brocolis",
            "arroz com brocolis",
            "arroz-doce",
            "arroz doce",
            "arroz temperado",
            "arroz carreteiro",
            "arroz a grega",
            "arroz com legumes",
            "arroz com cenoura",
            "arroz com frango",
            "arroz com carne",
            "arroz com camarao",
            "arroz biro biro",
            "arroz de forno",
            "arroz maluco",
            "risoto",
            "risotto",
            "bolinho de arroz",
            "sushi",
            "onigiri",

            // Produtos derivados
            "biscoito de arroz",
            "farinha de arroz",
            "bebida de arroz",
            "leite de arroz",
            "mingau",
            "creme de arroz",
            "papinha de arroz",
            "cereal de arroz",
            "flocos de arroz",
            "snack de arroz",
            "pipoca de arroz",
            "macarrao de arroz",
            "massa de arroz",
            "papel de arroz",

            // Alimentação animal
            "racao",
            "ração",
            "dog chow",
            "dog show",
            "alimento para caes",
            "alimento para cães",
            "alimento para gatos",
            "alimento p/caes",
            "alim.p/caes",
            "alim p caes",
            "cachorro",
            "cachorros",
            "cao adulto",
            "caes adultos",
            "gato",
            "gatos",
            "pet food",
            "alimentacao animal",
            "vinagre",
            "vinagrete",
            "bebida de arroz",
            "leite de arroz",
            "tempero",
            "molho",
            "farinha de arroz",
            "creme de arroz",
            "flocao de arroz",
            "flocao arroz",
            "arroz doce",
            "risoto pronto",
            "prato pronto",
            "refeicao pronta",
            "marmita",
            "biscoito de arroz",
            "snack de arroz",
            "salgadinho de arroz",
            "papel de arroz",
            "adicional arroz",
            "porcao de arroz",
            // Outros produtos incompatíveis
            "refeicao",
            "refeição",
            "prato feito",
            "refil",
            
            "brinquedo"
        ].some(p => n.includes(p));
}

    if (t.includes("farinha de mandioca")) {
        return !n.includes("farinha") || !n.includes("mandioca") || n.includes("farinha de trigo");
    }
    if (t.includes("macarrao")) {
        return !n.includes("macarrao") || n.includes("brinquedo");
    }
    if (t.includes("feijao")) {
        return !n.includes("feijao") || ["caldo", "tempero", "sopa", "extrato", "racao"].some(p => n.includes(p));
    }
    if (t.includes("carne bovina")) {
        return !n.includes("carne") || !n.includes("bovina") || ["caldo", "tempero", "racao"].some(p => n.includes(p));
    }
    if (t === "ovo" || t === "ovos") {
        return !/\bovos?\b/.test(n) || ["ovo de pascoa", "brinquedo"].some(p => n.includes(p));
    }
    if (t.includes("leite")) {
        // Para a cesta básica, leite em pó integral é tratado pela regra da categoria.
        // Na busca geral, exclui itens claramente não alimentícios ou substitutos.
        return !n.includes("leite") || [
            "bala", "sabonete", "biscoito", "composto lacteo",
            "bebida lactea", "formula infantil", "formula para lactentes",
            "mistura lactea", "suplemento alimentar", "achocolatado"
        ].some(p => n.includes(p));
    }
   // REFRIGERANTES E BEBIDAS
  // ==========================================
// REFRIGERANTES
// ==========================================
if (
    t.includes("refrigerante") ||
    t.includes("refri") ||
    t.includes("coca cola") ||
    t.includes("coca-cola") ||
    t.includes("pepsi") ||
    t.includes("fanta") ||
    t.includes("sprite") ||
    t.includes("guarana") ||
    t.includes("kuat") ||
    t.includes("sukita") ||
    t.includes("tuchaua") ||
    t.includes("schweppes") ||
    t.includes("itubaina") ||
    t.includes("dolly")
) {
    return !(
        n.includes("refrigerante") ||
        /\brefri\b/.test(n) ||
        n.includes("coca cola") ||
        n.includes("coca-cola") ||
        n.includes("pepsi") ||
        n.includes("fanta") ||
        n.includes("sprite") ||
        n.includes("guarana") ||
        n.includes("kuat") ||
        n.includes("sukita") ||
        n.includes("tuchaua") ||
        n.includes("schweppes") ||
        n.includes("itubaina") ||
        n.includes("dolly") ||
        n.includes("soda limonada") ||
        n.includes("tonica") ||
        n.includes("agua saborizada")
    ) ||
    [
        "detergente",
        "desinfetante",
        "amaciante",
        "limpador",
        "lava roupas",
        "sabao em po",
        "sabao liquido",
        "sabonete",
        "shampoo",
        "condicionador",
        "creme corporal",
        "aromatizador",
        "essencia",
        "produto de limpeza",
        "racao",
        "xarope para tosse"
    ].some(p => n.includes(p));
}
    // SABÃO
    if (t.includes("sabao")) {
        return !n.includes("sabao") ||
            [
                "sabonete", "sabao medicinal",
                "sabao para barba", "sabao de barbear",
                "sabao esfoliante", "sabao cosmetico",
                "sabao para artesanato", "base glicerinada",
                "sabao decorativo", "sabao para animais"
            ].some(p => n.includes(p));
    }

    // SABONETE
    if (t.includes("sabonete")) {
        return !n.includes("sabonete") ||
            [
                "sabonete liquido para loucas",
                "sabonete para roupas",
                "sabonete veterinario"
            ].some(p => n.includes(p));
    }

    // DETERGENTE
    if (t.includes("detergente")) {
        return !n.includes("detergente") ||
            [
                "detergente automotivo",
                "detergente industrial",
                "detergente enzimatico",
                "detergente para laboratorio",
                "detergente hospitalar",
                "detergente para instrumentos"
            ].some(p => n.includes(p));
    }

    // ÁGUA
    if (t === "agua" || t.startsWith("agua ")) {
        return !n.includes("agua") ||
            [
                "agua sanitaria", "agua oxigenada",
                "agua micelar", "agua termal",
                "agua de colonia", "agua perfumada",
                "agua destilada", "agua desmineralizada",
                "agua para bateria", "agua para radiador",
                "agua de coco", "agua tônica",
                "agua tonica", "agua saborizada para limpeza"
            ].some(p => n.includes(p));
    }

    // LEITE
    if (t.includes("leite")) {
        return !n.includes("leite") ||
            [
                "leite corporal", "leite de limpeza facial",
                "leite hidratante", "leite de banho",
                "leite de amendoas cosmetico",
                "leite para cabelo", "leite capilar",
                "leite para animais", "leite para bezerros",
                "leite em po para animais"
            ].some(p => n.includes(p));
    }

    // ÓLEO
    if (t.includes("oleo")) {
        return !n.includes("oleo") || [
            "oleo corporal",
            "oleo capilar",
            "oleo de cabelo",
            "oleo bronzeador",
            "oleo de banho",
            "oleo essencial",
            "oleo lubrificante",
            "oleo automotivo",
            "oleo de motor",
            "oleo hidraulico",
            "oleo de freio",
            "oleo de transmissao",
            "oleo mineral cosmetico",
            "oleo de massagem",
            "oleo de silicone",
            "oleo de peroba",
            "oleo para barba",
            "oleo pos banho",
            "oleo para bebe",
            "oleo de amendoas cosmetico",
            "lubrificante",
            "desengripante"
        ].some(p => n.includes(p));
    }

    // AÇÚCAR
    if (t.includes("acucar")) {
        return !n.includes("acucar") || [
            "acucarado",
            "bala",
            "balas",
            "refrigerante",
            "refresco",
            "suco",
            "nectar",
            "achocolatado",
            "chocolate",
            "bombom",
            "chiclete",
            "goma de mascar",
            "pirulito",
            "biscoito",
            "bolacha",
            "bolo",
            "panetone",
            "sorvete",
            "gelatina",
            "doce de leite",
            "geleia",
            "compota",
            "calda",
            "xarope",
            "cobertura",
            "sobremesa",
            "pudim",
            "mousse",
            "iogurte",
            "cereal matinal",
            "barra de cereal",
            "suplemento",
            "alimento para animais",
            "racao",
            "ração",
            "cosmetico",
            "esfoliante",
            "sabonete",
            "acucar de confeiteiro decorativo"
        ].some(p => n.includes(p));
    }

    // CAFÉ
    if (t.includes("cafe")) {
        return !n.includes("cafe") || [
            "cappuccino",
            "capuccino",
            "cappucino",
            "cafe da manha",
            "bala",
            "bala de cafe",
            "sabonete",
            "shampoo",
            "condicionador",
            "creme capilar",
            "creme corporal",
            "esfoliante",
            "perfume",
            "aromatizador",
            "essencia",
            "vela aromatica",
            "licor de cafe",
            "bebida sabor cafe",
            "sabor cafe",
            "recheio de cafe",
            "cobertura de cafe",
            "sorvete de cafe",
            "iogurte de cafe",
            "chocolate com cafe",
            "biscoito sabor cafe",
            "bolo de cafe",
            "suplemento de cafe",
            "cafe para pele",
            "capsula reutilizavel",
            "filtro de cafe",
            "cafeteira",
            "xicara de cafe",
            "copo para cafe",
            "garrafa para cafe"
        ].some(p => n.includes(p));
    }
 "creme dental": {
        termos: [
            "creme dental", "pasta de dente",
            "pasta dental"
        ],
        marcas: [
            "colgate", "oral b", "oral-b",
            "closeup", "close up", "sensodyne",
            "sorriso", "elmex"
        ],
        excluir: [
            "escova dental", "fio dental",
            "enxaguante bucal"
        ]
    },

    "papel higienico": {
        termos: [
            "papel higienico", "papel sanitario",
            "papel higiênico"
        ],
        marcas: [
            "neve", "personal", "fofinho",
            "mili", "duetto", "cotton"
        ],
        excluir: [
            "papel toalha", "guardanapo",
            "papel aluminio", "papel filme"
        ]
    },

    "racao para caes": {
        termos: [
            "racao para caes", "racao para cachorro",
            "alimento para caes", "alim.p/caes"
        ],
        marcas: [
            "pedigree", "dog chow", "dog show",
            "golden", "premier", "special dog",
            "magnus", "granplus", "whiskas"
        ],
        excluir: []
    }
};
    // SAL
    if (t.includes("sal")) {
        return !/\bsal\b/.test(n) || [
            "salgadinho",
            "salgado",
            "salgados",
            "salame",
            "salsicha",
            "salsichao",
            "salchicha",
            "salgadeira",
            "sal de banho",
            "sal esfoliante",
            "sal para banho",
            "sal amargo",
            "sal de fruta",
            "sal de frutas",
            "sal mineral para animais",
            "sal mineral bovino",
            "sal proteinado",
            "sal para gado",
            "sal para piscina",
            "sal regenerador",
            "sal para lava loucas",
            "sal de cura",
            "sal de parrilla temperado",
            "tempero pronto",
            "mistura para tempero",
            "caldo em cubo",
            "caldo de carne",
            "caldo de galinha",
            "sopa instantanea",
            "macarrao instantaneo",
            "biscoito salgado",
            "bolacha salgada",
            "amendoim salgado",
            "castanha salgada",
            "pipoca salgada",
            "batata chips",
            "batata frita",
            "petisco",
            "ração",
            "racao"
        ].some(p => n.includes(p));
    }

    // TERMOS GENÉRICOS: manter por último

    return !n.includes(t);
}

function correspondeCategoria(produto, item) {
    if (!produtoValido(produto)) return false;

    const nome = normalizar(produto.produto);
    const termos = Array.isArray(item.buscas) ? item.buscas.map(normalizar) : [normalizar(item.nome)];
    if (!termos.some(termo => termo && nome.includes(termo))) return false;

    const regrasPorId = {
        arroz: nome.includes("arroz") &&
            !["arroz de brocolis", "arroz doce", "refil"].some(p => nome.includes(p)),
        "farinha-mandioca": nome.includes("farinha") && nome.includes("mandioca") && !nome.includes("trigo"),
        macarrao: nome.includes("macarrao") && !nome.includes("brinquedo"),
        feijao: nome.includes("feijao") && !["caldo", "tempero", "sopa", "extrato", "racao"].some(p => nome.includes(p)),
        "carne-bovina": nome.includes("carne") && nome.includes("bovina") && !["caldo", "tempero", "racao"].some(p => nome.includes(p)),
        ovos: /\bovos?\b/.test(nome) && !["ovo de pascoa", "brinquedo"].some(p => nome.includes(p)),
        // Qualquer marca, mas somente leite em pó integral; exclui compostos e bebidas lácteas.
        leite: nome.includes("leite") &&
            nome.includes("po") &&
            nome.includes("integral") &&
            ![
                "composto lacteo", "bebida lactea", "formula infantil",
                "formula para lactentes", "mistura lactea", "suplemento alimentar",
                "achocolatado", "bala", "sabonete", "biscoito"
            ].some(p => nome.includes(p)),
        oleo: nome.includes("oleo") && !["oleo corporal", "oleo capilar", "lubrificante"].some(p => nome.includes(p)),
        acucar: nome.includes("acucar") && !["acucarado", "bala", "refrigerante"].some(p => nome.includes(p)),
        cafe: nome.includes("cafe") && !["cappuccino", "bala", "sabonete"].some(p => nome.includes(p)),
        sal: /\bsal\b/.test(nome) && !["salgadinho", "salgado", "salame"].some(p => nome.includes(p))
    };

    if (Object.prototype.hasOwnProperty.call(regrasPorId, item.id)) {
        return regrasPorId[item.id];
    }

    return !excluirResultadoIncompativel(nome, termos[0] || item.nome);
}

app.get("/", (_req, res) => {
    res.json({ projeto: "PreçoAí", mensagem: "API funcionando!", status: "online" });
});

app.get("/api/saude", (_req, res) => {
    const dados = obterProdutosSalvos();
    res.json({
        status: "online",
        preco_minimo: PRECO_MINIMO,
        arquivo_dados_encontrado: fs.existsSync(ARQUIVO_JSON),
        produtos_validos_salvos: dados.produtos.length,
        atualizado_em: dados.meta.data_atualizacao || null
    });
});

app.get("/api/busca-preco", async (req, res) => {
    const termoOriginal = String(req.query.busca || "").trim();
    const busca = normalizar(termoOriginal);

    if (!busca) {
        return res.status(400).json({ erro: "Informe o produto que deseja pesquisar." });
    }
    if (termoOriginal.length > 100) {
        return res.status(400).json({ erro: "A busca deve ter no máximo 100 caracteres." });
    }

    const precoMinimo = req.query.precoMinimo === undefined ? PRECO_MINIMO : Number(req.query.precoMinimo);
    if (!Number.isFinite(precoMinimo) || precoMinimo < PRECO_MINIMO) {
        return res.status(400).json({
            erro: `O preço mínimo não pode ser inferior a R$ ${PRECO_MINIMO.toFixed(2).replace(".", ",")}.`
        });
    }

    try {
        let resultado = cachePesquisas.get(busca);
        if (!resultado || Date.now() - resultado.timestamp >= TEMPO_CACHE_MS) {
            let coleta = pesquisasEmAndamento.get(busca);
            if (!coleta) {
                coleta = coletarPrecos(termoOriginal)
                    .then(produtos => {
                        salvarDados(produtos, termoOriginal);
                        const novoResultado = {
                            produtos: produtos.filter(produtoValido),
                            timestamp: Date.now(),
                            atualizadoEm: new Date().toISOString()
                        };
                        cachePesquisas.set(busca, novoResultado);
                        return novoResultado;
                    })
                    .finally(() => pesquisasEmAndamento.delete(busca));
                pesquisasEmAndamento.set(busca, coleta);
            }
            resultado = await coleta;
        }

        const produtos = resultado.produtos
            .filter(produtoValido)
            .filter(produto => normalizar(produto.produto).includes(busca))
            .filter(produto => precoDoProduto(produto) >= precoMinimo)
            .filter(produto => !excluirResultadoIncompativel(produto.produto, termoOriginal))
            .sort((a, b) => precoDoProduto(a) - precoDoProduto(b));

        return res.json({
            busca: termoOriginal,
            total: produtos.length,
            atualizado_em: resultado.atualizadoEm,
            preco_minimo_aplicado: precoMinimo,
            origem: "consulta à SEFAZ-AM; atualização conforme disponibilidade da fonte",
            produtos
        });
    } catch (erro) {
        console.error("Erro na coleta:", erro.message);

        // Se a fonte estiver indisponível, tenta responder com dados salvos.
        // A resposta identifica claramente que os preços não foram atualizados agora.
        const salvos = obterProdutosSalvos().produtos
            .filter(produto => normalizar(produto.produto).includes(busca))
            .filter(produto => precoDoProduto(produto) >= precoMinimo)
            .filter(produto => !excluirResultadoIncompativel(produto.produto, termoOriginal))
            .sort((a, b) => precoDoProduto(a) - precoDoProduto(b));

        if (salvos.length > 0) {
            return res.json({
                busca: termoOriginal,
                total: salvos.length,
                atualizado_em: obterProdutosSalvos().meta.data_atualizacao || null,
                preco_minimo_aplicado: precoMinimo,
                origem: "dados salvos localmente; consulta à SEFAZ indisponível",
                aviso: "Os preços exibidos podem não ser atuais.",
                produtos: salvos
            });
        }

        return res.status(502).json({
            erro: "Não foi possível consultar os preços agora e não há resultados salvos para esta busca.",
            detalhe: erro.message
        });
    }
});

app.get("/api/cesta-basica", (_req, res) => {
    try {
        if (!fs.existsSync(ARQUIVO_CESTA)) {
            return res.status(404).json({ erro: "Catálogo da cesta básica não encontrado." });
        }

        const catalogo = JSON.parse(fs.readFileSync(ARQUIVO_CESTA, "utf8"));
        const salvos = obterProdutosSalvos();
        const categorias = (Array.isArray(catalogo.categorias) ? catalogo.categorias : []).map(categoria => {
            const produtos = (Array.isArray(categoria.produtos) ? categoria.produtos : []).map(item => {
                const encontrados = salvos.produtos
                    .filter(produto => correspondeCategoria(produto, item))
                    .sort((a, b) => precoDoProduto(a) - precoDoProduto(b));

                return {
                    id: item.id,
                    nome: item.nome,
                    encontrado: encontrados.length > 0,
                    menor_preco: encontrados[0] || null,
                    total_encontrado: encontrados.length,
                    preco_minimo_aplicado: PRECO_MINIMO
                };
            });
            return { id: categoria.id, nome: categoria.nome, produtos };
        });

        return res.json({
            nome: catalogo.nome || "Cesta Básica PreçoAí",
            regiao: catalogo.regiao || "Amazonas",
            atualizado_em: salvos.meta.data_atualizacao || null,
            origem: "dados salvos localmente",
            preco_minimo_aplicado: PRECO_MINIMO,
            categorias
        });
    } catch (erro) {
        console.error("Erro na cesta básica:", erro);
        return res.status(500).json({
            erro: "Não foi possível montar a cesta básica.",
            detalhe: erro.message
        });
    }
});

app.get("/api/localidades", (_req, res) => {
    const { produtos, meta } = obterProdutosSalvos();
    const localidades = [...new Set(produtos.map(p => {
        const endereco = String(p.endereco || "");
        const partes = endereco.split(",").map(parte => parte.trim()).filter(Boolean);
        // Retorna apenas fragmentos de endereço existentes; não inventa bairros.
        return partes.find(parte => /\b(MANAUS|AM)\b/i.test(parte)) || null;
    }).filter(Boolean))].sort();

    res.json({
        total: localidades.length,
        localidades,
        atualizado_em: meta.data_atualizacao || null,
        observacao: "O arquivo de origem não possui bairro estruturado; os endereços são mantidos como fornecidos."
    });
});

app.post("/api/recarrega", async (req, res) => {
    const termo = String(req.body?.busca || "").trim();
    if (!termo) return res.status(400).json({ erro: "Informe o termo em busca." });
    if (termo.length > 100) return res.status(400).json({ erro: "A busca deve ter no máximo 100 caracteres." });

    try {
        const produtos = await coletarPrecos(termo);
        salvarDados(produtos, termo);
        cachePesquisas.set(normalizar(termo), {
            produtos,
            timestamp: Date.now(),
            atualizadoEm: new Date().toISOString()
        });
        return res.json({ sucesso: true, termo, total: produtos.length, preco_minimo_aplicado: PRECO_MINIMO });
    } catch (erro) {
        console.error("Erro ao recarregar dados:", erro.message);
        return res.status(502).json({ erro: "Não foi possível atualizar os dados.", detalhe: erro.message });
    }
});

if (require.main === module) {
    app.listen(PORT, () => console.log(`Servidor PreçoAí rodando na porta ${PORT}`));
}

module.exports = {
    app,
    normalizar,
    converterPreco,
    produtoValido,
    correspondeCategoria
};
