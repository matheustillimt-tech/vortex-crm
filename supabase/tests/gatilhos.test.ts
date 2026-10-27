// Regras dos gatilhos de início dos fluxos (supabase/functions/_shared/triggers-core.ts): formato antigo, palavra-chave,
// horários com fuso, filtros, reentrada, datas e o mapeamento do payload dos webhooks.
// Rodar: npx -y deno@2.9.6 test -A --no-lock --node-modules-dir=none supabase/tests/gatilhos.test.ts
import { describe, it } from "jsr:@std/testing@1/bdd";
import { expect } from "jsr:@std/expect@1";
import {
  dateTarget, failedCondition, flattenPaths, getPath, lastOccurrence, mapPayload, matchMessage, nextWindow, normalizePhone, parseBody,
  parseDate, passesFilters, reentryBlock, sameDay, startOf, withinHours, zonedToUtc, LEGACY_TRIGGER_ID,
} from "../functions/_shared/triggers-core.ts";
import { windowOpen } from "../functions/_shared/flow.ts";

// 2026-10-21 é quarta. 12:00Z = 09:00 em Brasília.
const qua9h = new Date("2026-10-21T12:00:00Z");

describe("formato do bloco Início", () => {
  it("palavras-chave antigas viram o gatilho Mensagem recebida com a mesma regra", () => {
    const s = startOf([{ id: "start", type: "start", data: { keywords: ["oi", "preço"] } }]);
    expect(s.legacy).toBe(true);
    expect(s.triggers).toHaveLength(1);
    expect(s.triggers[0]).toMatchObject({ id: LEGACY_TRIGGER_ID, type: "message", config: { mode: "keyword", match: "contains", wholeWord: true, ignoreAccents: false } });
  });
  it("Início antigo sem palavra-chave não ganha gatilho (não vira 'qualquer mensagem')", () => {
    expect(startOf([{ id: "start", type: "start", data: { label: "Início" } }]).triggers).toHaveLength(0);
    expect(startOf([{ id: "start", type: "start", data: { keywords: [] } }]).triggers).toHaveLength(0);
  });
  it("formato novo: gatilhos e regras com os padrões", () => {
    const s = startOf([{ type: "start", data: { triggers: [{ id: "a", type: "webhook" }], rules: { reentry: "once" } } }]);
    expect(s.legacy).toBe(false);
    expect(s.rules.reentry).toBe("once");
    expect(s.rules.ifInFlow).toBe("ignore");
  });
});

describe("palavra-chave e qualquer mensagem", () => {
  const legado = startOf([{ type: "start", data: { keywords: ["oi", "quero comprar"] } }]).triggers[0].config!;
  it("regra antiga: palavra inteira, sem diferenciar maiúsculas", () => {
    expect(matchMessage("Oi, tudo bem?", legado)).toBe(true);
    expect(matchMessage("OI", legado)).toBe(true);
    expect(matchMessage("oitenta reais", legado)).toBe(false);
    expect(matchMessage("eu QUERO COMPRAR agora", legado)).toBe(true);
  });
  it("modo qualquer mensagem e palavra-chave vazia aceitam tudo", () => {
    expect(matchMessage("qualquer coisa", { mode: "any" })).toBe(true);
    expect(matchMessage("qualquer coisa", { mode: "keyword", keywords: [] })).toBe(true);
    expect(matchMessage("📷 Imagem", { mode: "keyword", keywords: ["  "] })).toBe(true);
  });
  it("é exatamente / contém / começa com / termina com", () => {
    const k = (match: string, extra = {}) => ({ mode: "keyword", keywords: ["quero comprar"], match, ...extra });
    expect(matchMessage("quero comprar", k("exact"))).toBe(true);
    expect(matchMessage("quero comprar já", k("exact"))).toBe(false);
    expect(matchMessage("oi, quero comprar já", k("contains"))).toBe(true);
    expect(matchMessage("quero comprar já", k("starts"))).toBe(true);
    expect(matchMessage("oi quero comprar", k("starts"))).toBe(false);
    expect(matchMessage("oi quero comprar", k("ends"))).toBe(true);
  });
  it("ignorar maiúsculas e acentos é opcional", () => {
    expect(matchMessage("Qual o PRECO?", { mode: "keyword", keywords: ["preço"], match: "contains", ignoreAccents: true })).toBe(true);
    expect(matchMessage("Qual o PRECO?", { mode: "keyword", keywords: ["preço"], match: "contains", ignoreAccents: false })).toBe(false);
    expect(matchMessage("Preço", { mode: "keyword", keywords: ["preço"], match: "exact", ignoreCase: false })).toBe(false);
  });
  it("palavra inteira com acento", () => {
    expect(matchMessage("qual o preço?", { mode: "keyword", keywords: ["preço"], match: "contains", wholeWord: true })).toBe(true);
    expect(matchMessage("preçosbaixos", { mode: "keyword", keywords: ["preço"], match: "contains", wholeWord: true })).toBe(false);
  });
});

describe("dias e horários permitidos (com fuso)", () => {
  const seg_sex = { enabled: true, days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00", tz: "America/Sao_Paulo" };
  it("dentro e fora da janela", () => {
    expect(withinHours(seg_sex, qua9h)).toBe(true);
    expect(withinHours(seg_sex, new Date("2026-10-21T22:00:00Z"))).toBe(false); // 19h
    expect(withinHours(seg_sex, new Date("2026-10-24T13:00:00Z"))).toBe(false); // sábado
    expect(withinHours({ ...seg_sex, enabled: false }, new Date("2026-10-24T13:00:00Z"))).toBe(true);
  });
  it("janela que passa da meia-noite", () => {
    const noite = { enabled: true, days: [3], from: "22:00", to: "06:00", tz: "America/Sao_Paulo" };
    expect(withinHours(noite, new Date("2026-10-22T02:00:00Z"))).toBe(true); // qua 23h
    expect(withinHours(noite, new Date("2026-10-22T07:00:00Z"))).toBe(true); // qui 04h (começou na quarta)
    expect(withinHours(noite, new Date("2026-10-22T12:00:00Z"))).toBe(false);
  });
  it("próxima janela: sexta 19h → segunda 8h", () => {
    const at = nextWindow(seg_sex, new Date("2026-10-23T22:00:00Z"));
    expect(at?.toISOString()).toBe("2026-10-26T11:00:00.000Z");
  });
  it("hora local no fuso → instante", () => {
    expect(zonedToUtc(2026, 10, 21, 9, 0, "America/Sao_Paulo").toISOString()).toBe("2026-10-21T12:00:00.000Z");
    expect(zonedToUtc(2026, 10, 21, 9, 0, "Europe/Lisbon").toISOString()).toBe("2026-10-21T08:00:00.000Z");
  });
});

describe("filtros e reentrada", () => {
  const contact = { labels: ["vip"], origin: "Webhook", connection_id: "c1", fields: { cidade: "São Paulo" } };
  it("filtros", () => {
    expect(passesFilters({ labelsAny: ["vip"] }, { contact })).toBeNull();
    expect(passesFilters({ labelsNone: ["vip"] }, { contact })).not.toBeNull();
    expect(passesFilters({ origins: ["webhook"] }, { contact })).toBeNull();
    expect(passesFilters({ connections: ["c2"] }, { contact })).not.toBeNull();
    expect(passesFilters({ fields: [{ key: "cidade", op: "equals", value: "sao paulo" }] }, { contact })).toBeNull();
    expect(passesFilters({ kanbanId: "k1", columns: ["x"] }, { contact, cards: [{ kanban_id: "k1", column_id: "y" }] })).not.toBeNull();
    expect(passesFilters({ assignees: ["m1"] }, { contact, chat: { assigned_to: "m1" } })).toBeNull();
  });
  it("uma vez por contato, intervalo mínimo e sempre", () => {
    const runs = [{ started_at: "2026-10-21T10:00:00Z" }];
    expect(reentryBlock({ reentry: "always" }, runs, qua9h)).toBeNull();
    expect(reentryBlock({ reentry: "once" }, runs, qua9h)).not.toBeNull();
    expect(reentryBlock({ reentry: "once" }, [], qua9h)).toBeNull();
    expect(reentryBlock({ reentry: "interval", interval: { amount: 3, unit: "horas" } }, runs, qua9h)).not.toBeNull(); // 2 h atrás
    expect(reentryBlock({ reentry: "interval", interval: { amount: 1, unit: "horas" } }, runs, qua9h)).toBeNull();
  });
});

describe("datas", () => {
  it("formatos de data dos campos", () => {
    expect(parseDate("2026-10-21")).toEqual({ y: 2026, m: 10, d: 21 });
    expect(parseDate("21/10/2026")).toEqual({ y: 2026, m: 10, d: 21 });
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("2026-10-22T01:30:00Z")).toEqual({ y: 2026, m: 10, d: 21 }); // 22:30 do dia 21 em Brasília
    expect(parseDate("")).toBeNull();
  });
  it("antes, no dia e depois; todo ano (aniversário)", () => {
    const hoje = { y: 2026, m: 10, d: 21 };
    expect(dateTarget(hoje, "before", 3)).toEqual({ y: 2026, m: 10, d: 24 });
    expect(dateTarget(hoje, "after", 2)).toEqual({ y: 2026, m: 10, d: 19 });
    expect(dateTarget(hoje, "on", 5)).toEqual(hoje);
    expect(sameDay({ y: 1990, m: 10, d: 21 }, hoje, true)).toBe(true);
    expect(sameDay({ y: 1990, m: 10, d: 21 }, hoje, false)).toBe(false);
    expect(sameDay({ y: 2000, m: 2, d: 29 }, { y: 2027, m: 2, d: 28 }, true)).toBe(true);
  });
  it("horário programado: uma vez, todo dia, dias da semana, todo mês", () => {
    expect(lastOccurrence({ mode: "once", date: "2026-10-21", time: "08:30" }, qua9h)?.toISOString()).toBe("2026-10-21T11:30:00.000Z");
    expect(lastOccurrence({ mode: "once", date: "2026-10-21", time: "10:00" }, qua9h)).toBeNull();
    expect(lastOccurrence({ mode: "daily", time: "09:00" }, qua9h)?.toISOString()).toBe("2026-10-21T12:00:00.000Z");
    expect(lastOccurrence({ mode: "weekly", weekdays: [1], time: "09:00" }, qua9h)?.toISOString()).toBe("2026-10-19T12:00:00.000Z");
    expect(lastOccurrence({ mode: "monthly", monthDay: 5, time: "09:00" }, qua9h)?.toISOString()).toBe("2026-10-05T12:00:00.000Z");
    // criado depois da última ocorrência: não dispara a antiga
    expect(lastOccurrence({ mode: "daily", time: "08:00", createdAt: "2026-10-21T11:30:00Z" }, qua9h)).toBeNull();
  });
});

describe("webhook: payload real", () => {
  const hotmart = { event: "PURCHASE_APPROVED", data: { buyer: { name: "Ana Souza", email: "ANA@EXEMPLO.COM", checkout_phone: "(11) 3888-7777" }, purchase: { transaction: "HP123", price: { value: 97 } }, items: [{ name: "Curso" }] } };
  it("caminhos com ponto e índice", () => {
    expect(getPath(hotmart, "data.buyer.name")).toBe("Ana Souza");
    expect(getPath(hotmart, "data.items[0].name")).toBe("Curso");
    expect(getPath(hotmart, "data.items.0.name")).toBe("Curso");
    expect(getPath(hotmart, "data.nada.aqui")).toBeUndefined();
  });
  it('flattenPaths: valor longo corta em 200 por padrão e respeita maxValor (texto pronto de WhatsApp)', () => {
    const longo = 'x'.repeat(390) + 'https://agenda.exemplo.com.br/c/abcdefghjk'
    expect(flattenPaths({ mensagem: longo })[0].value.length).toBe(200)
    expect(flattenPaths({ mensagem: longo }, 150, 4000)[0].value).toBe(longo)
  })

  it("lista os campos do evento de teste", () => {
    const paths = flattenPaths(hotmart).map((p) => p.path);
    expect(paths).toContain("data.buyer.checkout_phone");
    expect(paths).toContain("data.items.0.name");
  });
  it("mapeia nome, telefone (com DDI), e-mail, campos e variáveis", () => {
    const m = mapPayload(hotmart, [
      { from: "data.buyer.name", to: "nome" }, { from: "data.buyer.checkout_phone", to: "telefone" }, { from: "data.buyer.email", to: "email" },
      { from: "data.purchase.transaction", to: "transacao" }, { from: "data.purchase.price.value", to: "var:valor" }, { from: "data.inexistente", to: "cidade" },
    ]);
    expect(m).toEqual({ name: "Ana Souza", phone: "551138887777", email: "ana@exemplo.com", fields: { transacao: "HP123" }, vars: { valor: "97" } });
  });
  it("telefone", () => {
    // números fictícios (fixo de 10 dígitos e um de 11 sem o 9): o que importa é a regra do DDI, não o número
    expect(normalizePhone("+55 (11) 3888-7777")).toBe("551138887777");
    expect(normalizePhone("1138887777")).toBe("551138887777");
    expect(normalizePhone("11888887777")).toBe("5511888887777");
    expect(normalizePhone("0055 11 3888-7777")).toBe("551138887777");
    expect(normalizePhone("1-555-0100")).toBe("");
  });
  it("condições por evento ou valor", () => {
    expect(failedCondition(hotmart, [{ path: "event", op: "equals", value: "purchase_approved" }])).toBeNull();
    expect(failedCondition(hotmart, [{ path: "event", op: "equals", value: "PURCHASE_REFUNDED" }])?.path).toBe("event");
    expect(failedCondition(hotmart, [{ path: "data.purchase.transaction", op: "exists" }])).toBeNull();
    expect(failedCondition(hotmart, [{ path: "data.cupom", op: "exists" }])?.path).toBe("data.cupom");
  });
  it("corpo JSON e formulário", () => {
    expect(parseBody('{"a":1}')).toEqual({ a: 1 });
    expect(parseBody("nome=Ana&buyer[phone]=1138887777", "application/x-www-form-urlencoded")).toEqual({ nome: "Ana", buyer: { phone: "1138887777" } });
    expect(() => parseBody("isto não é json")).toThrow();
  });
});

describe("permissão de envio", () => {
  const agora = Date.parse("2026-10-21T12:00:00Z");
  it("API oficial: texto livre só até 24 h depois da última mensagem do cliente", () => {
    expect(windowOpen("meta", "2026-10-21T00:00:00Z", agora)).toBe(true);
    expect(windowOpen("meta", "2026-10-19T12:00:00Z", agora)).toBe(false);
    expect(windowOpen("meta", null, agora)).toBe(false); // contato que nunca escreveu (ex.: veio de webhook)
    expect(windowOpen("zapbot", null, agora)).toBe(true);
  });
});
