/**
 * One-time, repeatable setup: turns the store's current header and footer links into menus
 * so the site looks the same after the menu builder ships. Locations that already have a menu are skipped.
 * Run: npx tsx scripts/setup-menus.ts
 */
import type { MenuLocation } from "@prisma/client";
import { prisma } from "../src/db";
import { SYSTEM_PAGES } from "../src/content/menus";

type Item = { label: string; href: string };

const HEADER_DEFAULT: Item[] = [
  { label: "Ana Sayfa", href: "/" },
  { label: "Ürünler", href: "/urunler" },
  { label: "Koleksiyonlar", href: "/koleksiyonlar" },
  { label: "Hikayemiz", href: "/hikayemiz" },
  { label: "Blog", href: "/blog" },
  { label: "İletişim", href: "/iletisim" },
];

const FOOTER: Array<{ location: MenuLocation; key: string; name: string; items: Item[] }> = [
  {
    location: "FOOTER_1",
    key: "footer-koleksiyon",
    name: "Koleksiyon",
    items: [
      { label: "Limon Çiçeği", href: "/urunler/limon-cicegi-kolonyasi" },
      { label: "Zeytin Çiçeği", href: "/urunler/zeytin-cicegi-kolonyasi" },
      { label: "Badem Çiçeği", href: "/urunler/badem-cicegi-kolonyasi" },
      { label: "Tüm koleksiyonlar", href: "/koleksiyonlar" },
    ],
  },
  {
    location: "FOOTER_2",
    key: "footer-ev",
    name: "Ev",
    items: [
      { label: "Hikayemiz", href: "/hikayemiz" },
      { label: "Blog", href: "/blog" },
      { label: "İletişim", href: "/iletisim" },
      { label: "Hesap", href: "/hesap" },
    ],
  },
];

/** Known store routes become "Sayfa" items; the label is kept only when it differs from the page name. */
function asItem(item: Item) {
  const system = SYSTEM_PAGES.find((page) => page.href === item.href);
  if (system) return { type: "PAGE" as const, pageKey: system.key, href: "", label: item.label === system.label ? "" : item.label };
  return { type: "CUSTOM" as const, pageKey: null, href: item.href, label: item.label };
}

async function main() {
  const done: string[] = [];

  if (!(await prisma.menu.findUnique({ where: { location: "HEADER" } }))) {
    const existing = await prisma.menu.findUnique({ where: { key: "header" }, include: { items: { orderBy: { sortOrder: "asc" } } } });
    if (existing) {
      for (const row of existing.items) {
        if (row.type !== "CUSTOM") continue;
        const next = asItem({ label: row.label, href: row.href });
        await prisma.menuItem.update({ where: { id: row.id }, data: next });
      }
      if (existing.items.length === 0) {
        await prisma.menuItem.createMany({ data: HEADER_DEFAULT.map((item, sortOrder) => ({ menuId: existing.id, sortOrder, ...asItem(item) })) });
      }
      await prisma.menu.update({ where: { id: existing.id }, data: { location: "HEADER" } });
      done.push(`Üst menü: mevcut “${existing.name}” menüsü atandı`);
    } else {
      await prisma.menu.create({
        data: { key: "header", name: "Üst menü", location: "HEADER", items: { create: HEADER_DEFAULT.map((item, sortOrder) => ({ sortOrder, ...asItem(item) })) } },
      });
      done.push("Üst menü oluşturuldu");
    }
  }

  for (const footer of FOOTER) {
    if (await prisma.menu.findUnique({ where: { location: footer.location } })) continue;
    let key = footer.key;
    for (let n = 2; await prisma.menu.findUnique({ where: { key } }); n += 1) key = `${footer.key}-${n}`;
    await prisma.menu.create({
      data: { key, name: footer.name, location: footer.location, items: { create: footer.items.map((item, sortOrder) => ({ sortOrder, ...asItem(item) })) } },
    });
    done.push(`${footer.location}: “${footer.name}” oluşturuldu`);
  }

  if (done.length) {
    await prisma.auditLog.create({ data: { action: "menu.setup", entityType: "menu", entityId: "setup", metadata: { text: "Mevcut header ve footer bağlantıları menülere aktarıldı.", steps: done } } });
  }
  console.log(done.length ? done.join("\n") : "Menüler zaten kurulu, değişiklik yok.");
  await prisma.$disconnect();
}

void main();
