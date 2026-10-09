import { afterAll, beforeAll, expect, test } from "vitest";
import { buildApp } from "../src/app";
import { loadEnv } from "../src/config/env";
import { loadDotEnv } from "../src/load-env";
import { prisma } from "../src/db";
import { editorMediaIds, pageDocumentSchema } from "../src/page-builder/schema";

loadDotEnv();
const env = loadEnv();
const slug = "editor-taslak-test";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  await prisma.page.deleteMany({ where: { slug } });
});

async function removePage(target: string) {
  const page = await prisma.page.findFirst({ where: { slug: target } });
  if (!page) return;
  if (page.publishedRevisionId) {
    await prisma.page.update({ where: { id: page.id }, data: { publishedRevisionId: null } });
  }
  await prisma.page.delete({ where: { id: page.id } });
}

afterAll(async () => {
  await prisma.page.deleteMany({ where: { slug } });
  await removePage("yayin-deneme-test");
  await app.close();
  await prisma.$disconnect();
});

function accessCookie(setCookie: string | string[] | undefined) {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const found = list.find((item) => item.startsWith("dm_access="));
  if (!found) throw new Error("dm_access çerezi yok");
  return found.split(";")[0];
}

const visibility = { desktop: true, tablet: true, mobile: true };
const spacing = { top: 0, right: 0, bottom: 0, left: 0 };

function version1() {
  return {
    version: 1 as const,
    sections: [
      {
        id: "eski",
        visibility,
        spacing,
        contained: true,
        columns: 1 as const,
        blocks: [
          {
            id: "eski-metin",
            type: "text" as const,
            visibility,
            spacing,
            props: { eyebrow: "", title: "Eski başlık", body: "Eski revizyon" },
          },
        ],
      },
    ],
  };
}

function version2(text: string) {
  return {
    version: 2 as const,
    sections: [],
    editor: {
      target: "home" as const,
      copies: {
        "home.hero.title": { text, fontSize: 48, color: "#8d7344", align: "center" as const, spaceTop: 12, width: { value: 520, unit: "px" as const } },
        "home.collections.card.limon-cicegi.title": { text: "Limon Bahçesi" },
      },
      layers: [
        {
          id: "ab12cd34",
          type: "text" as const,
          parentId: "home.collections.card.limon-cicegi",
          text: "Yeni metin",
          desktop: { x: 37, y: 52, width: 140, height: 40 },
        },
      ],
    },
  };
}

test("sürüm 1 belgeler açılır, sürüm 2 ana sayfa taslağını taşır", () => {
  expect(pageDocumentSchema.parse(version1()).version).toBe(1);
  const next = pageDocumentSchema.parse(version2("Datça’dan\nTeninize\nBahçenize\nRuhunuza"));
  expect(next.version).toBe(2);
  if (next.version !== 2) return;
  expect(next.editor?.copies["home.hero.title"]?.text).toContain("Bahçenize");
  expect(next.editor?.copies["home.hero.title"]?.width).toEqual({ value: 520, unit: "px" });
  expect(next.editor?.layers[0]?.desktop).toEqual({ x: 37, y: 52, width: 140, height: 40 });
  expect(() => pageDocumentSchema.parse({ version: 2, sections: [], editor: { target: "home", copies: {}, layers: [{ id: "kısa", type: "text" }] } })).toThrow();
  const percent = { version: 2, sections: [], editor: { target: "home", copies: { "home.hero.title": { width: { value: 80, unit: "%" } } }, layers: [] } };
  expect(pageDocumentSchema.parse(percent).version).toBe(2);
  const tooWide = { version: 2, sections: [], editor: { target: "home", copies: { "home.hero.title": { width: { value: 140, unit: "%" } } }, layers: [] } };
  expect(() => pageDocumentSchema.parse(tooWide)).toThrow();

  const styled = pageDocumentSchema.parse({
    version: 2,
    sections: [],
    editor: {
      target: "home",
      copies: {
        "home.hero.text": { fontFamily: "sans", fontWeight: 600, lineHeight: 1.4, letterSpacing: 0.5, fontSize: 18 },
        "home.features.gift.text": { text: "Hediye paketi" },
        "home.promos.card.hediye.action": { color: "#1e4a38" },
        "frame.footer.newsletter.title": { text: "Bahçe notları" },
        "frame.header.brand.tag": { fontSize: 10 },
      },
      layers: [],
    },
  });
  if (styled.version !== 2) throw new Error("sürüm 2 bekleniyordu");
  expect(styled.editor?.copies["home.hero.text"]).toEqual({ fontFamily: "sans", fontWeight: 600, lineHeight: 1.4, letterSpacing: 0.5, fontSize: 18 });
  const locked = (id: string) => ({ version: 2, sections: [], editor: { target: "home", copies: { [id]: { text: "x" } }, layers: [] } });
  expect(() => pageDocumentSchema.parse(locked("home.products.card.limon-cicegi-kolonyasi.price"))).toThrow();
  expect(() => pageDocumentSchema.parse(locked("home.products.card.limon-cicegi-kolonyasi.name"))).toThrow();
  expect(() => pageDocumentSchema.parse(locked("frame.notice"))).toThrow();
  expect(() => pageDocumentSchema.parse(locked("frame.header.tools.cart"))).toThrow();
  expect(() => pageDocumentSchema.parse({ version: 2, sections: [], editor: { target: "home", copies: { "home.hero.text": { fontWeight: 900 } }, layers: [] } })).toThrow();
});

function withImages(images: Record<string, unknown>) {
  return { version: 2, sections: [], editor: { target: "home", copies: {}, layers: [], images } };
}

test("görsel değişiklikleri öğe türüne göre sınırlanır", () => {
  const mediaId = "cmabcdefghijklmnopqrstu1";
  const parsed = pageDocumentSchema.parse(
    withImages({
      "home.hero.photo": { mediaId, fit: "contain", focusX: 30, focusY: 70, width: 500, height: 420, radius: 16, borderWidth: 2, borderColor: "#1e4a38" },
      "home.collections.card.limon-cicegi.photo": { mediaId, fit: "cover", focusX: 10, focusY: 90 },
      "home.story.photo": { focusX: 50, focusY: 20 },
      "home.promos.card.hediye.photo": { fit: "contain" },
      "frame.header.brand.mark": { mediaId },
      "frame.garden.desktop": { mediaId },
    }),
  );
  if (parsed.version !== 2) throw new Error("sürüm 2 bekleniyordu");
  expect(parsed.editor?.images?.["home.hero.photo"]?.focusX).toBe(30);

  const rejects = [
    { "home.products.card.limon-cicegi-kolonyasi.photo": { mediaId } },
    { "home.collections.card.limon-cicegi.photo": { height: 300 } },
    { "home.story.photo": { radius: 10 } },
    { "frame.header.brand.mark": { fit: "contain" } },
    { "frame.garden.mobile": { width: 200 } },
    { "home.hero.photo": { mediaId: "../../etc/passwd" } },
    { "home.hero.photo": { mediaId: "https://kotu.example.com/a.png" } },
    { "home.hero.photo": { focusX: 140 } },
  ];
  for (const images of rejects) {
    expect(pageDocumentSchema.safeParse(withImages(images)).success, JSON.stringify(images)).toBe(false);
  }

  const rawSource = pageDocumentSchema.parse(withImages({ "home.hero.photo": { src: "javascript:alert(1)", focusX: 40 } }));
  if (rawSource.version !== 2) throw new Error("sürüm 2 bekleniyordu");
  expect(rawSource.editor?.images?.["home.hero.photo"]).toEqual({ focusX: 40 });
});

function withBoxes(boxes: Record<string, unknown>) {
  return { version: 2, sections: [], editor: { target: "home", copies: {}, layers: [], boxes } };
}

test("bölüm, konteyner ve kart tasarımı doğrulanır, ticari öğeler kapalı kalır", () => {
  const mediaId = "cmabcdefghijklmnopqrstu1";
  const design = {
    background: "#f6f1e7",
    backgroundMediaId: mediaId,
    width: 640,
    height: 320,
    minHeight: 280,
    borderWidth: 2,
    borderColor: "#1e4a38",
    radius: 24,
    shadow: { x: 0, y: 8, blur: 24, color: "#28200f", opacity: 12 },
    opacity: 90,
    paddingTop: 12,
    paddingRight: 16,
    paddingBottom: 20,
    paddingLeft: 24,
    marginTop: 8,
    marginRight: 0,
    marginBottom: 32,
    marginLeft: 4,
  };
  const parsed = pageDocumentSchema.parse(
    withBoxes({
      "home.hero": design,
      "home.hero.copy": { paddingLeft: 40 },
      "home.collections.grid": { background: "#ffffff" },
      "home.collections.card.limon-cicegi": { radius: 0, borderWidth: 1 },
      "home.promos.card.hediye": { shadow: { x: 2, y: -4, blur: 0, color: "#000000", opacity: 100 } },
      "home.features.gift": { background: "#fffdf8" },
      "home.products.card.limon-cicegi-kolonyasi": { borderColor: "#8d7344", radius: 8 },
      "home.products.card.limon-cicegi-kolonyasi.body": { paddingTop: 20 },
    }),
  );
  if (parsed.version !== 2) throw new Error("sürüm 2 bekleniyordu");
  expect(parsed.editor?.boxes?.["home.hero"]).toEqual(design);

  const rejects: Record<string, unknown>[] = [
    { "home.products.card.limon-cicegi-kolonyasi.price": { background: "#ffffff" } },
    { "home.products.card.limon-cicegi-kolonyasi.cart": { radius: 4 } },
    { "home.products.card.limon-cicegi-kolonyasi.name": { paddingTop: 4 } },
    { "frame.notice": { background: "#ffffff" } },
    { "frame.header": { background: "#ffffff" } },
    { "home.hero.title": { paddingTop: 4 } },
    { "home.hero": { paddingTop: -1 } },
    { "home.hero": { marginLeft: 401 } },
    { "home.hero": { opacity: 0 } },
    { "home.hero": { width: 10 } },
    { "home.hero": { background: "red" } },
    { "home.hero": { backgroundMediaId: "https://kotu.example.com/a.png" } },
    { "home.hero": { shadow: { x: 0, y: 0, blur: 300, color: "#000000", opacity: 10 } } },
    { "home.hero": { radius: 2.5 } },
  ];
  for (const boxes of rejects) {
    expect(pageDocumentSchema.safeParse(withBoxes(boxes)).success, JSON.stringify(boxes)).toBe(false);
  }

  const stripped = pageDocumentSchema.parse(withBoxes({ "home.story": { backgroundImage: "url(javascript:alert(1))", radius: 12 } }));
  if (stripped.version !== 2) throw new Error("sürüm 2 bekleniyordu");
  expect(stripped.editor?.boxes?.["home.story"]).toEqual({ radius: 12 });
  expect(editorMediaIds(parsed)).toEqual([mediaId]);
});

function withNodes(nodes: unknown[], layers: unknown[] = []) {
  return { version: 2, sections: [], editor: { target: "home", copies: {}, layers, nodes } };
}

const freeNodes = [
  {
    id: "c0ffee01",
    type: "container",
    parentId: "home.collections.card.limon-cicegi",
    order: 0,
    frame: { width: 200, height: 280 },
    desktop: { x: 16, y: 16, width: 160, height: 120 },
    style: { background: "#fffdf8", borderWidth: 1, borderColor: "#e4d8c4", radius: 12, opacity: 90, shadow: { x: 0, y: 4, blur: 12, color: "#000000", opacity: 20 } },
  },
  {
    id: "c0ffee02",
    type: "text",
    parentId: "c0ffee01",
    order: 0,
    text: "Kutu içi\nmetin",
    desktop: { x: 8, y: 8, width: 120, height: 40 },
    style: { fontSize: 18, color: "#1a2e24", fontWeight: 600, align: "center", fontFamily: "sans", lineHeight: 1.2 },
  },
  { id: "c0ffee03", type: "text", parentId: "home.hero.copy", order: 1, text: "Serbest", desktop: { x: 0, y: 0, width: 100, height: 30 } },
];

function chain(depth: number) {
  return Array.from({ length: depth }, (_, index) => ({
    id: `d000000${index}`,
    type: "container",
    parentId: index === 0 ? "home.story" : `d000000${index - 1}`,
    order: 0,
    desktop: { x: 0, y: 0, width: 100, height: 100 },
  }));
}

test("serbest öğeler: kimlik, hiyerarşi, konum ve stil doğrulanır", () => {
  const parsed = pageDocumentSchema.parse(withNodes(freeNodes));
  if (parsed.version !== 2) throw new Error("sürüm 2 bekleniyordu");
  expect(parsed.editor?.nodes).toEqual(freeNodes);
  expect(pageDocumentSchema.parse(withNodes(chain(4))).version).toBe(2);
  expect(pageDocumentSchema.parse(withNodes([])).version).toBe(2);

  const many = Array.from({ length: 200 }, (_, index) => ({
    id: index.toString(16).padStart(8, "0"),
    type: "text",
    parentId: "home.hero",
    order: index,
    text: "x",
    desktop: { x: 0, y: 0, width: 20, height: 20 },
  }));
  expect(pageDocumentSchema.safeParse(withNodes(many)).success).toBe(true);

  const [box, inner, free] = freeNodes;
  const rejects: [string, unknown[], unknown[]?][] = [
    ["201 öğe", [...many, { ...free, id: "ffffffff" }]],
    ["5 seviye", chain(5)],
    ["döngü", [{ ...box, id: "aaaaaaaa", parentId: "bbbbbbbb" }, { ...box, id: "bbbbbbbb", parentId: "aaaaaaaa" }]],
    ["kendine bağlı", [{ ...box, parentId: "c0ffee01" }]],
    ["olmayan üst", [{ ...inner, parentId: "deadbeef" }]],
    ["metin içine öğe", [free, { ...inner, parentId: "c0ffee03" }]],
    ["aynı kimlik", [box, { ...free, id: "c0ffee01" }]],
    ["eski katmanla aynı kimlik", [{ ...free, id: "ab12cd34" }], [{ id: "ab12cd34", type: "text", parentId: "home.collections.card.limon-cicegi", text: "x", desktop: { x: 0, y: 0, width: 20, height: 20 } }]],
    ["ürün kartı", [{ ...free, parentId: "home.products.card.limon-cicegi-kolonyasi" }]],
    ["ürün ızgarası", [{ ...free, parentId: "home.products.grid" }]],
    ["sayfa çerçevesi", [{ ...free, parentId: "frame.header" }]],
    ["kısa kimlik", [{ ...free, id: "abc" }]],
    ["büyük harf kimlik", [{ ...free, id: "C0FFEE09" }]],
    ["negatif konum", [{ ...free, desktop: { x: -1, y: 0, width: 10, height: 10 } }]],
    ["kesirli boyut", [{ ...free, desktop: { x: 0, y: 0, width: 10.5, height: 10 } }]],
    ["sıfır genişlik", [{ ...free, desktop: { x: 0, y: 0, width: 0, height: 10 } }]],
    ["sıra taşması", [{ ...free, order: 1000 }]],
    ["bilinmeyen tür", [{ ...free, type: "image" }]],
    ["bilinmeyen alan", [{ ...free, html: "<script>" }]],
    ["bilinmeyen stil", [{ ...free, style: { backgroundImage: "url(javascript:1)" } }]],
    ["metne konteyner stili", [{ ...free, style: { background: "#ffffff" } }]],
    ["geçersiz renk", [{ ...free, style: { color: "red" } }]],
    ["yazı boyutu", [{ ...free, style: { fontSize: 200 } }]],
    ["opaklık", [{ ...box, style: { opacity: 0 } }]],
    ["uzun metin", [{ ...free, text: "x".repeat(2001) }]],
  ];
  for (const [name, nodes, layers] of rejects) {
    expect(pageDocumentSchema.safeParse(withNodes(nodes, layers)).success, name).toBe(false);
  }
});

function deviceNodes() {
  const [box, inner, free] = freeNodes;
  return [
    { ...box, tablet: { box: { x: 8, y: 8, width: 150, height: 110 }, frame: { width: 180, height: 250 } }, mobile: { box: { x: 4, y: 4, width: 120, height: 100 }, frame: { width: 140, height: 200 } } },
    { ...inner, mobile: { box: { x: 2, y: 2, width: 100, height: 36 } } },
    free,
  ];
}

test("tablet ve telefon konumları masaüstünden ayrı saklanır ve doğrulanır", () => {
  const nodes = deviceNodes();
  const parsed = pageDocumentSchema.parse(withNodes(nodes));
  if (parsed.version !== 2) throw new Error("sürüm 2 bekleniyordu");
  expect(parsed.editor?.nodes).toEqual(nodes);
  expect(parsed.editor?.nodes?.[0].desktop).toEqual(freeNodes[0].desktop);

  const [box] = nodes;
  const rejects: [string, unknown][] = [
    ["kutusuz cihaz ayarı", { ...box, mobile: { frame: { width: 100, height: 100 } } }],
    ["bilinmeyen cihaz alanı", { ...box, mobile: { box: box.desktop, color: "#ffffff" } }],
    ["cihazda çok küçük yazı", { ...box, mobile: { box: box.desktop, fontSize: 10 } }],
    ["bilinmeyen cihaz", { ...box, watch: { box: box.desktop } }],
    ["negatif cihaz konumu", { ...box, tablet: { box: { x: -4, y: 0, width: 10, height: 10 } } }],
    ["kesirli cihaz boyutu", { ...box, mobile: { box: { x: 0, y: 0, width: 10.5, height: 10 } } }],
    ["sınır dışı cihaz çerçevesi", { ...box, mobile: { box: box.desktop, frame: { width: 5000, height: 10 } } }],
    ["kutuda bilinmeyen alan", { ...box, tablet: { box: { ...box.desktop, z: 3 } } }],
  ];
  for (const [name, node] of rejects) {
    expect(pageDocumentSchema.safeParse(withNodes([node, nodes[1], nodes[2]])).success, name).toBe(false);
  }
});

function deviceStyles() {
  return {
    copies: {
      "home.hero.title": { text: "Başlık", color: "#1a2e24", fontSize: 64, lineHeight: 1.1, tablet: { fontSize: 44, letterSpacing: 0.5 }, mobile: { fontSize: 30, lineHeight: 1.2, spaceTop: 4, width: { value: 100, unit: "%" } } },
    },
    links: {
      "home.hero.cta": { text: "Keşfet", background: "#1e4a38", fontSize: 18, mobile: { fontSize: 15, width: 220, paddingY: 10, marginTop: 8 } },
    },
    images: {
      "home.hero.photo": { fit: "cover", width: 520, tablet: { width: 420, height: 320 }, mobile: { height: 240, radius: 12 } },
    },
    boxes: {
      "home.collections.card.limon-cicegi": { background: "#fffdf8", minHeight: 320, tablet: { minHeight: 280, paddingTop: 12 }, mobile: { minHeight: 220, marginBottom: 16 } },
      "home.hero": { paddingTop: 48, mobile: { paddingTop: 16, paddingLeft: 12, paddingRight: 12 } },
    },
  };
}

function withStyles(styles: ReturnType<typeof deviceStyles>) {
  return { version: 2, sections: [], editor: { target: "home", layers: [], ...styles } };
}

test("cihaz bazlı metin, buton, görsel ve kutu ayarları masaüstünden ayrı doğrulanır", () => {
  const styles = deviceStyles();
  const parsed = pageDocumentSchema.parse(withStyles(styles));
  if (parsed.version !== 2) throw new Error("sürüm 2 bekleniyordu");
  expect(parsed.editor?.copies).toEqual(styles.copies);
  expect(parsed.editor?.links).toEqual(styles.links);
  expect(parsed.editor?.images).toEqual(styles.images);
  expect(parsed.editor?.boxes).toEqual(styles.boxes);

  const title = styles.copies["home.hero.title"];
  const cta = styles.links["home.hero.cta"];
  const photo = styles.images["home.hero.photo"];
  const card = styles.boxes["home.collections.card.limon-cicegi"];
  const rejects: [string, Record<string, Record<string, unknown>>][] = [
    ["telefonda çok küçük yazı", { copies: { "home.hero.title": { ...title, mobile: { fontSize: 10 } } } }],
    ["cihazda ortak alan", { copies: { "home.hero.title": { ...title, mobile: { color: "#000000" } } } }],
    ["cihazda metin", { copies: { "home.hero.title": { ...title, tablet: { text: "x" } } } }],
    ["cihazda geçersiz genişlik", { copies: { "home.hero.title": { ...title, mobile: { width: { value: 10, unit: "%" } } } } }],
    ["bilinmeyen cihaz alanı", { boxes: { ...styles.boxes, "home.hero": { mobile: { gap: 4 } } } }],
    ["kutu cihazında renk", { boxes: { ...styles.boxes, "home.hero": { mobile: { background: "#ffffff" } } } }],
    ["butonda küçük yazı", { links: { "home.hero.cta": { ...cta, tablet: { fontSize: 9 } } } }],
    ["butonda adres cihazda", { links: { "home.hero.cta": { ...cta, mobile: { href: "/x" } } } }],
    ["kart bağlantısında cihaz", { links: { "home.collections.card.limon-cicegi": { href: "/koleksiyonlar", mobile: { width: 200 } } } }],
    ["kapak görselinde cihaz", { images: { "home.story.photo": { fit: "cover", mobile: { height: 200 } } } }],
    ["görsel cihazında medya", { images: { "home.hero.photo": { ...photo, tablet: { mediaId: mediaNodeId } } } }],
    ["kutu cihazında taşma", { boxes: { "home.collections.card.limon-cicegi": { ...card, mobile: { paddingTop: 500 } } } }],
  ];
  for (const [name, change] of rejects) {
    expect(pageDocumentSchema.safeParse(withStyles({ ...styles, ...change } as unknown as ReturnType<typeof deviceStyles>)).success, name).toBe(false);
  }
});

const mediaNodeId = "cmabcdefghijklmnopqrstu1";

function richNodes(mediaId = mediaNodeId) {
  return [
    ...freeNodes,
    {
      id: "1a9e0001",
      type: "image",
      parentId: "c0ffee01",
      order: 1,
      mediaId,
      alt: "Limon bahçesi",
      desktop: { x: 4, y: 50, width: 120, height: 60 },
      style: { fit: "contain", focusX: 30, focusY: 70, radius: 8, borderWidth: 1, borderColor: "#e4d8c4" },
    },
    {
      id: "b0770001",
      type: "button",
      parentId: "home.collections.card.limon-cicegi",
      order: 1,
      text: "Keşfet",
      href: "/koleksiyonlar/limon",
      desktop: { x: 20, y: 200, width: 140, height: 44 },
      style: { background: "#1e4a38", color: "#fffdf8", fontSize: 15, fontWeight: 600, borderWidth: 2, borderColor: "#8d7344", radius: 999 },
    },
    { id: "1c0e0001", type: "icon", parentId: "home.hero.copy", order: 2, icon: "flower", desktop: { x: 0, y: 40, width: 48, height: 48 }, style: { color: "#8d7344" } },
    { id: "1c0e0002", type: "image", parentId: "home.story", order: 0, desktop: { x: 0, y: 0, width: 100, height: 80 } },
  ];
}

test("görsel, buton ve ikon öğeleri: medya, bağlantı, ikon listesi ve hiyerarşi doğrulanır", () => {
  const nodes = richNodes();
  const parsed = pageDocumentSchema.parse(withNodes(nodes));
  if (parsed.version !== 2) throw new Error("sürüm 2 bekleniyordu");
  expect(parsed.editor?.nodes).toEqual(nodes);
  expect(editorMediaIds(parsed)).toEqual([mediaNodeId]);

  const [image, button, icon] = nodes.slice(3);
  const rejects: [string, unknown][] = [
    ["medya yolu", { ...image, mediaId: "../../etc/passwd" }],
    ["medya adresi", { ...image, mediaId: "https://kotu.example.com/a.png" }],
    ["görsel kaynağı alanı", { ...image, src: "javascript:alert(1)" }],
    ["görsel stili", { ...image, style: { fit: "fill" } }],
    ["odak", { ...image, style: { focusX: 120 } }],
    ["javascript bağlantı", { ...button, href: "javascript:alert(1)" }],
    ["data bağlantı", { ...button, href: "data:text/html,<b>x</b>" }],
    ["protokolsüz bağlantı", { ...button, href: "//kotu.example.com" }],
    ["boş buton metni", { ...button, text: "" }],
    ["çok satırlı buton", { ...button, text: "İki\nsatır" }],
    ["buton yazı boyutu", { ...button, style: { fontSize: 200 } }],
    ["buton bilinmeyen stil", { ...button, style: { backgroundImage: "url(x)" } }],
    ["bilinmeyen ikon", { ...icon, icon: "skull" }],
    ["svg ikon", { ...icon, icon: "<svg onload=alert(1)>" }],
    ["ikon boyut stili", { ...icon, style: { size: 40 } }],
    ["ikon bilinmeyen alan", { ...icon, svg: "<path/>" }],
    ["ürün kartında buton", { ...button, parentId: "home.products.card.limon-cicegi-kolonyasi" }],
  ];
  for (const [name, node] of rejects) {
    expect(pageDocumentSchema.safeParse(withNodes([node])).success, name).toBe(false);
  }
  for (const leaf of [image, button, icon]) {
    const child = { ...freeNodes[2], id: "c1d00001", parentId: (leaf as { id: string }).id };
    expect(pageDocumentSchema.safeParse(withNodes([...nodes, child])).success, `${(leaf as { type: string }).type} içine öğe`).toBe(false);
  }
});

function withLinks(links: Record<string, unknown>) {
  return { version: 2, sections: [], editor: { target: "home", copies: {}, layers: [], links } };
}

test("buton ve bağlantı değişiklikleri doğrulanır, tehlikeli adresler reddedilir", () => {
  const parsed = pageDocumentSchema.parse(
    withLinks({
      "home.hero.cta": { text: "Kokuları Keşfet", href: "/urunler", background: "#8d7344", color: "#ffffff", fontSize: 18, width: 240, height: 52, borderWidth: 2, borderColor: "#1e4a38", radius: 12, paddingY: 10, paddingX: 24, marginTop: 8, marginLeft: 4 },
      "home.collections.more": { href: "https://datcamis.com/koleksiyonlar" },
      "home.collections.card.limon-cicegi": { href: "/koleksiyonlar/limon" },
      "frame.header.nav.urunler": { text: "Kolonyalar" },
      "frame.footer.house.iletisim": { href: "mailto:merhaba@datcamis.local" },
      "frame.footer.collections.limon-cicegi": { href: "#limon" },
    }),
  );
  if (parsed.version !== 2) throw new Error("sürüm 2 bekleniyordu");
  expect(parsed.editor?.links?.["home.hero.cta"]?.href).toBe("/urunler");
  expect(pageDocumentSchema.parse(withLinks({})).version).toBe(2);
  expect(pageDocumentSchema.parse({ version: 2, sections: [], editor: { target: "home", copies: {}, layers: [] } }).version).toBe(2);

  for (const href of [
    "javascript:alert(1)",
    " JavaScript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "//kotu.example.com",
    "http://datcamis.com",
    "https://",
    "/\\kotu.example.com",
    "urunler",
    "",
  ]) {
    expect(() => pageDocumentSchema.parse(withLinks({ "home.hero.cta": { href } })), href).toThrow();
  }

  expect(() => pageDocumentSchema.parse(withLinks({ "home.hero.title": { href: "/urunler" } }))).toThrow();
  expect(() => pageDocumentSchema.parse(withLinks({ "frame.footer.house.title": { href: "/urunler" } }))).toThrow();
  expect(() => pageDocumentSchema.parse(withLinks({ "frame.header.tools.cart": { href: "/urunler" } }))).toThrow();
  expect(() => pageDocumentSchema.parse(withLinks({ "home.products.card.limon-cicegi-kolonyasi": { href: "/urunler" } }))).toThrow();
  expect(() => pageDocumentSchema.parse(withLinks({ "frame.footer.newsletter.submit": { text: "Gönder" } }))).toThrow();
  expect(() => pageDocumentSchema.parse(withLinks({ "home.collections.card.limon-cicegi": { text: "Kart" } }))).toThrow();
  expect(() => pageDocumentSchema.parse(withLinks({ "home.hero.cta": { radius: -1 } }))).toThrow();
  expect(() => pageDocumentSchema.parse(withLinks({ "home.hero.cta": { text: "İki\nsatır" } }))).toThrow();
});

test("ana sayfa taslağı yayınlanmaz, eski revizyon kalır ve çakışan kayıt reddedilir", async () => {
  const publishedBefore = await prisma.page.findMany({
    where: { status: "PUBLISHED", deletedAt: null },
    select: { id: true, slug: true, publishedRevisionId: true },
  });

  for (const page of publishedBefore) {
    const response = await app.inject({ method: "GET", url: `/api/v1/content/pages/${page.slug}` });
    expect(response.statusCode).toBe(200);
    const document = response.json().data.document;
    expect(document.version).toBe(1);
    expect(document.editor).toBeUndefined();
  }

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/admin/auth/login",
    payload: { email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  const cookie = accessCookie(login.headers["set-cookie"]);

  const created = await app.inject({
    method: "POST",
    url: "/api/v1/admin/pages",
    headers: { cookie },
    payload: { title: "Editör taslak testi", slug, document: version2("İlk taslak") },
  });
  expect(created.statusCode).toBe(200);
  const pageId = created.json().data.id as string;
  expect(created.json().data.status).toBe("DRAFT");

  const hidden = await app.inject({ method: "GET", url: `/api/v1/content/pages/${slug}` });
  expect(hidden.statusCode).toBe(404);

  const stale = await app.inject({
    method: "POST",
    url: `/api/v1/admin/pages/${pageId}/revisions`,
    headers: { cookie },
    payload: { document: version2("Eski sekme"), baseVersion: 0 },
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().error.code).toBe("REVISION_CONFLICT");

  const unsafe = await app.inject({
    method: "POST",
    url: `/api/v1/admin/pages/${pageId}/revisions`,
    headers: { cookie },
    payload: { document: withLinks({ "home.hero.cta": { href: "javascript:alert(1)" } }), baseVersion: 1 },
  });
  expect(unsafe.statusCode).toBe(400);

  const missingMedia = await app.inject({
    method: "POST",
    url: `/api/v1/admin/pages/${pageId}/revisions`,
    headers: { cookie },
    payload: { document: withImages({ "home.hero.photo": { mediaId: "cmyokboylebirmedyakaydi1" } }), baseVersion: 1 },
  });
  expect(missingMedia.statusCode).toBe(400);
  expect(missingMedia.json().error.code).toBe("MEDIA_NOT_ALLOWED");

  const saved = await app.inject({
    method: "POST",
    url: `/api/v1/admin/pages/${pageId}/revisions`,
    headers: { cookie },
    payload: { document: version2("İkinci taslak"), baseVersion: 1 },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json().data.version).toBe(2);
  expect(saved.json().data.status).toBe("DRAFT");

  const legacy = await app.inject({
    method: "POST",
    url: `/api/v1/admin/pages/${pageId}/revisions`,
    headers: { cookie },
    payload: { document: version1() },
  });
  expect(legacy.statusCode).toBe(200);
  expect(legacy.json().data.document.version).toBe(1);

  const realMedia = await prisma.media.findFirst({ where: { deletedAt: null, mimeType: { in: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"] } } });
  expect(realMedia).not.toBeNull();
  const withMedia = await app.inject({
    method: "POST",
    url: `/api/v1/admin/pages/${pageId}/revisions`,
    headers: { cookie },
    payload: { document: withImages({ "home.hero.photo": { mediaId: realMedia!.id, focusX: 20, focusY: 80 } }), baseVersion: 3 },
  });
  expect(withMedia.statusCode).toBe(200);
  expect(withMedia.json().data.document.editor.images["home.hero.photo"]).toEqual({ mediaId: realMedia!.id, focusX: 20, focusY: 80 });

  const detail = await app.inject({ method: "GET", url: `/api/v1/admin/pages/${pageId}`, headers: { cookie } });
  const revisions = detail.json().data.revisions as { version: number; document: { version: number } }[];
  expect(revisions.map((item) => item.document.version).sort()).toEqual([1, 2, 2, 2]);

  const restarted = await buildApp(env);
  await restarted.ready();
  try {
    const reread = await restarted.inject({ method: "GET", url: `/api/v1/admin/pages/${pageId}`, headers: { cookie } });
    expect(reread.statusCode).toBe(200);
    const latest = reread.json().data.revisions[0];
    expect(latest.id).toBe(withMedia.json().data.id);
    expect(latest.version).toBe(4);
    expect(latest.document.editor.images["home.hero.photo"].mediaId).toBe(realMedia!.id);
  } finally {
    await restarted.close();
  }

  const missingBackground = await app.inject({
    method: "POST",
    url: `/api/v1/admin/pages/${pageId}/revisions`,
    headers: { cookie },
    payload: { document: withBoxes({ "home.hero": { backgroundMediaId: "cmyokboylebirmedyakaydi1" } }), baseVersion: 4 },
  });
  expect(missingBackground.statusCode).toBe(400);
  expect(missingBackground.json().error.code).toBe("MEDIA_NOT_ALLOWED");

  const boxDesign = { "home.hero": { backgroundMediaId: realMedia!.id, paddingTop: 24, radius: 16 }, "home.products.card.limon-cicegi-kolonyasi": { radius: 4 } };
  const withDesign = await app.inject({
    method: "POST",
    url: `/api/v1/admin/pages/${pageId}/revisions`,
    headers: { cookie },
    payload: { document: withBoxes(boxDesign), baseVersion: 4 },
  });
  expect(withDesign.statusCode).toBe(200);
  expect(withDesign.json().data.version).toBe(5);
  const designed = await app.inject({ method: "GET", url: `/api/v1/admin/pages/${pageId}`, headers: { cookie } });
  expect(designed.json().data.revisions[0].document.editor.boxes).toEqual(boxDesign);
  expect(designed.json().data.revisions[1].document.editor.boxes).toBeUndefined();

  const badTree = await app.inject({
    method: "POST",
    url: `/api/v1/admin/pages/${pageId}/revisions`,
    headers: { cookie },
    payload: { document: withNodes(chain(5)), baseVersion: 5 },
  });
  expect(badTree.statusCode).toBe(400);

  const withFree = await app.inject({
    method: "POST",
    url: `/api/v1/admin/pages/${pageId}/revisions`,
    headers: { cookie },
    payload: { document: withNodes(freeNodes), baseVersion: 5 },
  });
  expect(withFree.statusCode).toBe(200);
  expect(withFree.json().data.version).toBe(6);
  const reloaded = await app.inject({ method: "GET", url: `/api/v1/admin/pages/${pageId}`, headers: { cookie } });
  expect(reloaded.json().data.revisions[0].document.editor.nodes).toEqual(freeNodes);
  expect(reloaded.json().data.revisions[1].document.editor.nodes).toBeUndefined();

  const missingNodeMedia = await app.inject({
    method: "POST",
    url: `/api/v1/admin/pages/${pageId}/revisions`,
    headers: { cookie },
    payload: { document: withNodes(richNodes("cmyokboylebirmedyakaydi1")), baseVersion: 6 },
  });
  expect(missingNodeMedia.statusCode).toBe(400);
  expect(missingNodeMedia.json().error.code).toBe("MEDIA_NOT_ALLOWED");

  const rich = richNodes(realMedia!.id);
  const withRich = await app.inject({
    method: "POST",
    url: `/api/v1/admin/pages/${pageId}/revisions`,
    headers: { cookie },
    payload: { document: withNodes(rich), baseVersion: 6 },
  });
  expect(withRich.statusCode).toBe(200);
  expect(withRich.json().data.version).toBe(7);
  const richRead = await app.inject({ method: "GET", url: `/api/v1/admin/pages/${pageId}`, headers: { cookie } });
  expect(richRead.json().data.revisions[0].document.editor.nodes).toEqual(rich);

  const perDevice = deviceNodes();
  const withDevices = await app.inject({
    method: "POST",
    url: `/api/v1/admin/pages/${pageId}/revisions`,
    headers: { cookie },
    payload: { document: withNodes(perDevice), baseVersion: 7 },
  });
  expect(withDevices.statusCode).toBe(200);
  expect(withDevices.json().data.version).toBe(8);
  const devicesRead = await app.inject({ method: "GET", url: `/api/v1/admin/pages/${pageId}`, headers: { cookie } });
  expect(devicesRead.json().data.revisions[0].document.editor.nodes).toEqual(perDevice);

  const styles = deviceStyles();
  const withDeviceStyles = await app.inject({
    method: "POST",
    url: `/api/v1/admin/pages/${pageId}/revisions`,
    headers: { cookie },
    payload: { document: withStyles(styles), baseVersion: 8 },
  });
  expect(withDeviceStyles.statusCode).toBe(200);
  expect(withDeviceStyles.json().data.version).toBe(9);
  const stylesRead = await app.inject({ method: "GET", url: `/api/v1/admin/pages/${pageId}`, headers: { cookie } });
  const storedEditor = stylesRead.json().data.revisions[0].document.editor;
  expect({ copies: storedEditor.copies, links: storedEditor.links, images: storedEditor.images, boxes: storedEditor.boxes }).toEqual(styles);
  expect(stylesRead.json().data.revisions[1].document.editor.nodes).toEqual(perDevice);

  const publishedAfter = await prisma.page.findMany({
    where: { status: "PUBLISHED", deletedAt: null },
    select: { id: true, publishedRevisionId: true },
  });
  const byId = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id);
  expect([...publishedAfter].sort(byId)).toEqual(publishedBefore.map(({ id, publishedRevisionId }) => ({ id, publishedRevisionId })).sort(byId));

  const stillHidden = await app.inject({ method: "GET", url: `/api/v1/content/pages/${slug}` });
  expect(stillHidden.statusCode).toBe(404);
});

test("ana sayfa taslağı yayınlanamaz, başka bir CMS sayfası yayınlanır", async () => {
  const before = await prisma.page.findMany({
    where: { status: "PUBLISHED", deletedAt: null, slug: { notIn: ["ana-sayfa", "yayin-deneme-test"] } },
    select: { id: true, publishedRevisionId: true },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/admin/auth/login",
    payload: { email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD },
  });
  const cookie = accessCookie(login.headers["set-cookie"]);
  // The real homepage draft belongs to the user: only inspect it, never create or delete it here.
  const home = await prisma.page.findFirst({
    where: { slug: "ana-sayfa", deletedAt: null },
    include: { _count: { select: { revisions: true } } },
  });
  if (home) {
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/admin/pages/${home.id}/publish`,
      headers: { cookie },
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error.code).toBe("PUBLISH_UNSUPPORTED");
    const homeAfter = await prisma.page.findFirstOrThrow({
      where: { id: home.id },
      include: { _count: { select: { revisions: true } } },
    });
    expect(homeAfter.status).toBe(home.status);
    expect(homeAfter.publishedRevisionId).toBe(home.publishedRevisionId);
    expect(homeAfter._count.revisions).toBe(home._count.revisions);
  }

  await removePage("yayin-deneme-test");
  const other = await app.inject({
    method: "POST",
    url: "/api/v1/admin/pages",
    headers: { cookie },
    payload: { title: "Yayın denemesi", slug: "yayin-deneme-test", document: version1() },
  });
  expect(other.statusCode).toBe(200);
  const otherId = other.json().data.id as string;
  const published = await app.inject({
    method: "POST",
    url: `/api/v1/admin/pages/${otherId}/publish`,
    headers: { cookie },
  });
  expect(published.statusCode).toBe(200);
  const visible = await app.inject({ method: "GET", url: "/api/v1/content/pages/yayin-deneme-test" });
  expect(visible.statusCode).toBe(200);
  expect(visible.json().data.document.version).toBe(1);
  expect(visible.json().data.document.editor).toBeUndefined();

  const after = await prisma.page.findMany({
    where: { status: "PUBLISHED", deletedAt: null, slug: { notIn: ["ana-sayfa", "yayin-deneme-test"] } },
    select: { id: true, publishedRevisionId: true },
  });
  const byId = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id);
  expect([...after].sort(byId)).toEqual([...before].sort(byId));

  await removePage("yayin-deneme-test");
});
